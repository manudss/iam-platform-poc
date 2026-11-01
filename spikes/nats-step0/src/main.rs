//! Spike étape 0 : essais réels NATS pour le bus géré par le core.
//! Usage : nats-step0-spike <scenario> [url]. Scénarios : calls, forge, js, accounts, load.
use async_nats::{jetstream, Client, ConnectOptions};
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Errs = Arc<Mutex<Vec<String>>>;

async fn conn(url: &str, user: &str, inbox: Option<&str>) -> (Client, Errs) {
    let errs: Errs = Arc::default();
    let e2 = errs.clone();
    let mut o = ConnectOptions::with_user_and_password(user.into(), user.into()).event_callback(move |ev| {
        let e2 = e2.clone();
        async move {
            if let async_nats::Event::ServerError(s) = &ev {
                e2.lock().unwrap().push(s.to_string());
            }
        }
    });
    if let Some(p) = inbox {
        o = o.custom_inbox_prefix(p);
    }
    (o.connect(url).await.unwrap_or_else(|e| panic!("connexion {user}: {e}")), errs)
}

/// Plugin simulé : s'abonne à plugin.<id>.call et répond selon son comportement.
async fn plugin(url: &str, id: &'static str) -> (Client, Errs) {
    let (c, errs) = conn(url, id, Some(&format!("_INBOX.{id}"))).await;
    let mut sub = c.subscribe(format!("plugin.{id}.call")).await.unwrap();
    let c2 = c.clone();
    tokio::spawn(async move {
        while let Some(m) = sub.next().await {
            let Some(reply) = m.reply.clone() else { continue };
            let c3 = c2.clone();
            tokio::spawn(async move {
                match id {
                    "a" => { c3.publish(reply, format!("{{\"plugin\":\"a\",\"nom\":\"Alice\"}}").into()).await.ok(); }
                    "b" => { tokio::time::sleep(Duration::from_millis(50)).await; c3.publish(reply, "{\"plugin\":\"b\",\"dept\":\"R&D\"}".into()).await.ok(); }
                    "d" => { tokio::time::sleep(Duration::from_millis(2000)).await; c3.publish(reply, "{\"plugin\":\"d\"}".into()).await.ok(); }
                    _ => {} // c : muet
                }
            });
        }
    });
    c.flush().await.unwrap();
    (c, errs)
}

/// Appel du core vers un plugin : une requête par plugin, délai propre. None = muet ou trop lent.
async fn call(core: &Client, id: &str, deadline: Duration) -> Option<String> {
    let r = tokio::time::timeout(deadline, core.request(format!("plugin.{id}.call"), "{}".into())).await;
    match r {
        Ok(Ok(m)) => Some(String::from_utf8_lossy(&m.payload).to_string()),
        _ => None,
    }
}

async fn calls(url: &str) {
    let core = conn(url, "core", None).await.0;
    let ids = ["a", "b", "c", "d"];
    let mut keep = vec![];
    for id in ids { keep.push(plugin(url, id).await); }
    let t = Instant::now();
    let deadline = Duration::from_millis(300);
    let res = futures::future::join_all(ids.iter().map(|id| call(&core, id, deadline))).await;
    println!("fan-out 4 plugins, délai 300 ms : total {:?}", t.elapsed());
    for (id, r) in ids.iter().zip(&res) { println!("  {id}: {}", r.as_deref().unwrap_or("(aucune réponse dans le délai)")); }
    // Règle du core : profil = union des réponses reçues ; muet omis.
    let got: Vec<_> = ids.iter().zip(&res).filter(|(_, r)| r.is_some()).map(|(i, _)| *i).collect();
    println!("profil : réponses de {:?}, omis {:?}", got, ids.iter().filter(|i| !got.contains(i)).collect::<Vec<_>>());
    // Règle du core : contrôle obligatoire muet = refus (fail-closed) ; non obligatoire muet = ignoré.
    for mandatory in [vec!["a", "b"], vec!["a", "c"]] {
        let ok = mandatory.iter().all(|m| got.contains(m));
        println!("auth, obligatoires {:?} : {}", mandatory, if ok { "AUTORISÉ" } else { "REFUS (fail-closed)" });
    }
    drop(keep);
}

async fn forge(url: &str) {
    let core = conn(url, "core", None).await.0;
    let (_a, ea) = plugin(url, "a").await;
    let (b, eb) = conn(url, "b", Some("_INBOX.b")).await;
    // Le core demande à a avec un sujet de réponse précis, que l'on suppose divulgué à b.
    let reply = core.new_inbox();
    let mut sub = core.subscribe(reply.clone()).await.unwrap();
    core.publish_with_reply("plugin.a.call", reply.clone(), "{}".into()).await.unwrap();
    // b tente de répondre à la place de a, avec le sujet exact.
    b.publish(reply.clone(), "{\"plugin\":\"FORGÉ par b\"}".into()).await.ok();
    b.flush().await.ok();
    // b tente aussi de publier sur un sujet du bus et d'écouter l'inbox de a.
    b.publish("plugin.a.call", "x".into()).await.ok();
    let sb = b.subscribe("_INBOX.a.>").await;
    let sb2 = b.subscribe("_INBOX.>").await;
    b.flush().await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut n = 0;
    while let Ok(Some(m)) = tokio::time::timeout(Duration::from_millis(200), sub.next()).await {
        n += 1; println!("core reçoit sur le sujet de réponse : {}", String::from_utf8_lossy(&m.payload));
    }
    println!("messages reçus par le core : {n} (attendu 1, de a)");
    println!("b : subscribe _INBOX.a.> -> {:?}, _INBOX.> -> {:?} (la souscription peut être acceptée côté client, l'erreur vient du serveur)", sb.is_ok(), sb2.is_ok());
    println!("erreurs serveur vues par b : {:?}", eb.lock().unwrap());
    println!("erreurs serveur vues par a : {:?}", ea.lock().unwrap());
}

async fn js(url: &str) {
    let (core, _) = conn(url, "core", None).await;
    let j = jetstream::new(core.clone());
    let _ = j.delete_stream("EVT").await;
    let stream = j.create_stream(jetstream::stream::Config {
        name: "EVT".into(), subjects: vec!["evt.>".into()],
        duplicate_window: Duration::from_secs(120), ..Default::default() }).await.unwrap();
    stream.create_consumer(jetstream::consumer::pull::Config {
        durable_name: Some("mail".into()), filter_subject: "evt.mail.send".into(),
        ack_wait: Duration::from_secs(10), ..Default::default() }).await.unwrap();
    // Déduplication (D5/D16) : même Nats-Msg-Id = un seul message stocké.
    for i in 0..2 {
        let mut h = async_nats::HeaderMap::new();
        h.insert("Nats-Msg-Id", "effect-123");
        let ack = j.publish_with_headers("evt.mail.send", h, format!("mail {i}").into()).await.unwrap().await.unwrap();
        println!("publication {i} : seq {} doublon={}", ack.sequence, ack.duplicate);
    }
    for i in 0..6 { j.publish("evt.mail.send", format!("m{i}").into()).await.unwrap().await.unwrap(); }
    // Deux plugins mail (e1, e2) tirent depuis le même consommateur durable : un seul traite chaque message.
    let mut hs = vec![];
    for id in ["e1", "e2"] {
        let url = url.to_string();
        hs.push(tokio::spawn(async move {
            let (c, errs) = conn(&url, id, Some(&format!("_INBOX.{id}"))).await;
            let cj = jetstream::new(c);
            let cons = match cj.get_consumer_from_stream::<jetstream::consumer::pull::Config, _, _>("mail", "EVT").await {
                Ok(c) => c,
                Err(e) => return (id, 0usize, vec![format!("get_consumer refusé : {e}")]),
            };
            let mut n = 0;
            loop {
                let mut msgs = cons.fetch().max_messages(1).expires(Duration::from_millis(600)).messages().await.unwrap();
                match tokio::time::timeout(Duration::from_millis(800), msgs.next()).await {
                    Ok(Some(Ok(m))) => { tokio::time::sleep(Duration::from_millis(30)).await; m.ack().await.ok(); n += 1; }
                    _ => break,
                }
            }
            let e = errs.lock().unwrap().clone();
            (id, n, e)
        }));
    }
    for h in hs { let (id, n, e) = h.await.unwrap(); println!("plugin mail {id} : {n} message(s) traités ; erreurs serveur {e:?}"); }
    println!("(7 messages stockés : 1 dédoublonné par Nats-Msg-Id + 6 ; chacun est traité par un seul plugin)");
    // Droit refusé : e1 ne doit pas pouvoir créer de flux ni lire un autre consommateur.
    let (c, errs) = conn(url, "e1", Some("_INBOX.e1")).await;
    let cj = jetstream::new(c);
    let r = tokio::time::timeout(Duration::from_secs(2), cj.create_stream(jetstream::stream::Config { name: "PIRATE".into(), subjects: vec!["pirate.>".into()], ..Default::default() })).await;
    println!("e1 crée un flux : {}", match r { Ok(Ok(_)) => "ACCEPTÉ (problème)".into(), Ok(Err(e)) => format!("refusé : {e}"), Err(_) => "refusé (délai dépassé, pas de réponse)".into() });
    tokio::time::sleep(Duration::from_millis(200)).await;
    println!("erreurs serveur vues par e1 : {:?}", errs.lock().unwrap());
}

async fn accounts(url: &str) {
    let (iam, _) = conn(url, "iam", None).await;
    let (other, _) = conn(url, "other", None).await;
    let mut s_other = other.subscribe("evt.>").await.unwrap();
    other.flush().await.unwrap();
    iam.publish("evt.secret", "du compte IAM".into()).await.unwrap();
    iam.flush().await.unwrap();
    let r = tokio::time::timeout(Duration::from_millis(500), s_other.next()).await;
    println!("compte OTHER reçoit un événement du compte IAM : {}", if r.is_ok() { "OUI (problème)" } else { "non (isolé)" });
    let (ji, jo) = (jetstream::new(iam.clone()), jetstream::new(other.clone()));
    // Même nom de flux dans deux comptes : pas de collision.
    let mk = |n: &str| jetstream::stream::Config { name: n.into(), subjects: vec!["evt.>".into()], ..Default::default() };
    println!("flux EVT dans IAM : {:?}", ji.get_or_create_stream(mk("EVT")).await.map(|_| "ok").map_err(|e| e.to_string()));
    println!("flux EVT dans OTHER : {:?}", jo.get_or_create_stream(mk("EVT")).await.map(|_| "ok").map_err(|e| e.to_string()));
    // Quota : OTHER est limité à 1 flux.
    let mut m1 = mk("EVT1"); m1.subjects = vec!["evt1.>".into()];
    println!("2e flux dans OTHER (quota 2) : {:?}", jo.create_stream(m1).await.map(|_| "ok").map_err(|e| e.to_string()));
    let mut m2 = mk("EVT2"); m2.subjects = vec!["evt2.>".into()];
    println!("3e flux dans OTHER (quota 2) : {:?}", jo.create_stream(m2).await.map(|_| "ok").map_err(|e| e.to_string()));
    // Quota de stockage : OTHER plafonné à 8 Mo (on libère un flux pour ne tester que le stockage).
    let _ = jo.delete_stream("EVT1").await;
    let mut big = jetstream::stream::Config { name: "BIG".into(), subjects: vec!["big.>".into()], max_bytes: 16 * 1024 * 1024, ..Default::default() };
    big.storage = jetstream::stream::StorageType::File;
    println!("flux de 16 Mo dans OTHER (quota stockage 8 Mo) : {:?}", jo.create_stream(big).await.map(|_| "ok").map_err(|e| e.to_string()));
    let info = jo.query_account().await;
    println!("infos compte OTHER : {:?}", info.map(|i| (i.limits.max_memory, i.limits.max_storage, i.limits.max_streams)).map_err(|e| e.to_string()));
}

async fn jspub(url: &str) {
    let (core, _) = conn(url, "core", None).await;
    let j = jetstream::new(core);
    let _ = j.delete_stream("LOAD").await;
    j.create_stream(jetstream::stream::Config { name: "LOAD".into(), subjects: vec!["load.>".into()], storage: jetstream::stream::StorageType::File, max_age: Duration::from_secs(60), ..Default::default() }).await.unwrap();
    let n = 5000;
    let t = Instant::now();
    let payload = bytes::Bytes::from(vec![b'x'; 512]);
    let mut acks = vec![];
    for i in 0..n {
        acks.push(j.publish(format!("load.e{}", i % 10), payload.clone()).await.unwrap());
        if acks.len() >= 100 { for a in acks.drain(..) { a.await.unwrap(); } }
    }
    for a in acks { a.await.unwrap(); }
    println!("{n} événements JetStream (512 o, stockage fichier, acquittés) : {:?} soit {:.0} évts/s", t.elapsed(), n as f64 / t.elapsed().as_secs_f64());
}

async fn load(url: &str) {
    let core = conn(url, "core", None).await.0;
    let mut keep = vec![];
    for id in ["a", "b"] { keep.push(plugin(url, id).await); }
    let n: usize = std::env::var("LOAD_N").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let mut lat = vec![];
    let t = Instant::now();
    for _ in 0..n {
        let s = Instant::now();
        let r = futures::future::join_all(["a", "b"].iter().map(|id| call(&core, id, Duration::from_secs(2)))).await;
        assert!(r.iter().all(|x| x.is_some()));
        lat.push(s.elapsed());
    }
    lat.sort();
    println!("{n} fan-out séquentiels vers 2 plugins : total {:?}, p50 {:?}, p95 {:?}, p99 {:?}", t.elapsed(), lat[n / 2], lat[n * 95 / 100], lat[n * 99 / 100]);
    drop(keep);
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let url = a.get(2).cloned().unwrap_or("127.0.0.1:4444".into());
    match a.get(1).map(String::as_str) {
        Some("calls") => calls(&url).await,
        Some("forge") => forge(&url).await,
        Some("js") => js(&url).await,
        Some("accounts") => accounts(&url).await,
        Some("load") => load(&url).await,
        Some("jspub") => jspub(&url).await,
        _ => eprintln!("scénarios : calls forge js accounts load"),
    }
}
