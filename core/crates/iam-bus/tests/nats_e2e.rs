//! End-to-end on a REAL nats-server (spawned here, config conf/nats-local.conf on a random port).
//! Needs the `nats-server` binary: path in NATS_SERVER_BIN or `nats-server` on PATH. Skipped (loudly) when absent unless
//! IAM_REQUIRE_NATS=1, which CI-like runs must set.
use async_trait::async_trait;
use iam_bus::nats::{self, NatsTransport};
use iam_bus::*;
use serde_json::json;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct Server { child: Child, url: String }
impl Drop for Server { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }

fn start(port: u16) -> Option<Server> {
    let bin = std::env::var("NATS_SERVER_BIN").unwrap_or_else(|_| "nats-server".into());
    let conf = format!("{}/../../../conf/nats-local.conf", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&conf).unwrap().replace("127.0.0.1:4222", &format!("127.0.0.1:{port}")).replace("/tmp/iam-nats-js", &format!("/tmp/iam-nats-js-{port}"));
    let tmp = format!("/tmp/iam-bus-test-{port}.conf");
    std::fs::write(&tmp, text).unwrap();
    let child = Command::new(&bin).args(["-c", &tmp]).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    let child = match child { Ok(c) => c, Err(e) => { assert!(std::env::var("IAM_REQUIRE_NATS").is_err(), "nats-server required: {e}"); eprintln!("SKIPPED: no nats-server ({e})"); return None } };
    for _ in 0..50 { if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() { return Some(Server { child, url: format!("127.0.0.1:{port}") }) } std::thread::sleep(Duration::from_millis(100)); }
    panic!("nats-server did not start");
}

struct Fixed(Option<HandlerResult>, u64);
#[async_trait]
impl Handler for Fixed {
    async fn handle(&self, _e: &Envelope) -> Option<HandlerResult> { tokio::time::sleep(Duration::from_millis(self.1)).await; self.0.clone() }
}
fn allow() -> Option<HandlerResult> { Some(HandlerResult { verdict: Some(Verdict::Allow), data: None }) }
fn deny() -> Option<HandlerResult> { Some(HandlerResult { verdict: Some(Verdict::Deny), data: None }) }

fn cat() -> Catalogue {
    Catalogue::new().declare("auth.check", Mode::Control).declare("profile.get", Mode::Query).declare("user.created", Mode::Notify)
}
fn sub(id: &str, kind: &str, mandatory: bool, group: Option<&str>) -> Subscription {
    Subscription { subscriber: id.into(), kind: kind.into(), mandatory, group: group.map(Into::into) }
}
async fn plugin(url: &str, id: &str, h: Arc<dyn Handler>) -> (tokio::task::JoinHandle<()>, nats::ServerErrors) {
    let (c, errs) = nats::connect(url, id, id, Some(&format!("_INBOX.{id}"))).await.unwrap();
    (nats::serve(c, id, h).await.unwrap(), errs)
}
async fn core(url: &str) -> Dispatcher {
    let (c, _) = nats::connect(url, "core", "core-dev", None).await.unwrap();
    Dispatcher::new(cat(), Arc::new(NatsTransport::new(c)), Duration::from_millis(400))
}
fn env(id: &str, kind: &str) -> Envelope { Envelope::new(id, kind, json!({})) }

#[tokio::test]
async fn control_fan_out_fail_closed_and_isolation() {
    let Some(s) = start(14301) else { return };
    let _a = plugin(&s.url, "sub-a", Arc::new(Fixed(allow(), 0))).await;
    let _b = plugin(&s.url, "sub-b", Arc::new(Fixed(allow(), 50))).await;
    let _c = plugin(&s.url, "sub-c", Arc::new(Fixed(None, 0))).await; // silent
    let d = core(&s.url).await;
    // all answer: allow
    d.subscribe(sub("sub-a", "auth.check", true, None)).unwrap();
    d.subscribe(sub("sub-b", "auth.check", true, None)).unwrap();
    assert_eq!(d.call(&env("1", "auth.check"), None).await.unwrap().verdict, Verdict::Allow);
    // optional silent: ignored, the others still answer (error isolation)
    d.subscribe(sub("sub-c", "auth.check", false, None)).unwrap();
    let t = std::time::Instant::now();
    let r = d.call(&env("2", "auth.check"), None).await.unwrap();
    assert_eq!(r.verdict, Verdict::Allow);
    assert!(t.elapsed() < Duration::from_millis(900), "parallel, bounded by the timeout");
    assert!(r.outcomes.iter().any(|o| o.subscriber == "sub-c" && matches!(o.status, SubStatus::Silent(_))));
    // mandatory silent: refusal
    d.unsubscribe("sub-c");
    d.subscribe(sub("sub-c", "auth.check", true, None)).unwrap();
    let r = d.call(&env("3", "auth.check"), None).await.unwrap();
    assert_eq!(r.verdict, Verdict::Deny);
    assert!(r.reason.unwrap().contains("sub-c"));
}

#[tokio::test]
async fn deny_wins_and_no_responder_on_mandatory_is_refusal() {
    let Some(s) = start(14302) else { return };
    let _a = plugin(&s.url, "sub-a", Arc::new(Fixed(allow(), 0))).await;
    let _b = plugin(&s.url, "sub-b", Arc::new(Fixed(deny(), 0))).await;
    let d = core(&s.url).await;
    d.subscribe(sub("sub-a", "auth.check", false, None)).unwrap();
    d.subscribe(sub("sub-b", "auth.check", false, None)).unwrap();
    assert_eq!(d.call(&env("1", "auth.check"), None).await.unwrap().verdict, Verdict::Deny);
    // subscriber that never connected, mandatory: refusal, not a hang
    d.unsubscribe("sub-b");
    d.subscribe(sub("sub-c", "auth.check", true, None)).unwrap();
    assert_eq!(d.call(&env("2", "auth.check"), None).await.unwrap().verdict, Verdict::Deny);
}

#[tokio::test]
async fn query_merge_and_missing_answer_rule() {
    let Some(s) = start(14303) else { return };
    let da = |v| Some(HandlerResult { verdict: None, data: Some(v) });
    let _a = plugin(&s.url, "sub-a", Arc::new(Fixed(da(json!({"nom": "Alice", "dept": "R&D"})), 0))).await;
    let _b = plugin(&s.url, "sub-b", Arc::new(Fixed(da(json!({"dept": "Ventes", "tel": "1"})), 0))).await;
    let d = core(&s.url).await;
    d.subscribe(sub("sub-a", "profile.get", true, None)).unwrap();
    d.subscribe(sub("sub-b", "profile.get", false, None)).unwrap();
    d.subscribe(sub("sub-c", "profile.get", false, None)).unwrap(); // optional, never connected
    let m = d.query(&env("1", "profile.get"), None).await.unwrap();
    assert_eq!(m.data, json!({"nom": "Alice", "dept": "R&D", "tel": "1"}));
    assert_eq!(m.conflicts, vec!["dept".to_string()]);
    assert!(m.refused.is_none());
    d.unsubscribe("sub-c");
    d.subscribe(sub("sub-c", "profile.get", true, None)).unwrap();
    assert!(d.query(&env("2", "profile.get"), None).await.unwrap().refused.is_some());
}

/// A forged reply must not be accepted. Two layers: NATS permissions (the forger cannot publish to the reply subject,
/// measured here through the server error) and the core's own `from`/`id` check.
#[tokio::test]
async fn reply_forgery_is_refused_by_server_and_by_core_check() {
    let Some(s) = start(14304) else { return };
    let (b, berrs) = nats::connect(&s.url, "sub-b", "sub-b", Some("_INBOX.sub-b")).await.unwrap();
    let (core_c, _) = nats::connect(&s.url, "core", "core-dev", None).await.unwrap();
    let reply = core_c.new_inbox();
    let mut sub_r = core_c.subscribe(reply.clone()).await.unwrap();
    core_c.flush().await.unwrap();
    b.publish(reply.clone(), br#"{"from":"sub-a","id":"x","verdict":"allow"}"#.to_vec().into()).await.ok();
    b.flush().await.ok();
    tokio::time::sleep(Duration::from_millis(300)).await;
    use futures::StreamExt;
    assert!(tokio::time::timeout(Duration::from_millis(200), sub_r.next()).await.is_err(), "core must receive nothing");
    assert!(berrs.lock().unwrap().iter().any(|e| e.to_lowercase().contains("permissions violation")), "server refused: {:?}", berrs.lock().unwrap());

    // Core-side check (a subscriber that lies about `from`, or answers for another envelope) is covered in unit tests
    // with the in-process transport; here a handler answers honestly: the host sets `from` itself.
    let _a = plugin(&s.url, "sub-a", Arc::new(Fixed(allow(), 0))).await;
    let d = core(&s.url).await;
    d.subscribe(sub("sub-a", "auth.check", true, None)).unwrap();
    let r = d.call(&env("9", "auth.check"), None).await.unwrap();
    assert!(matches!(&r.outcomes[0].status, SubStatus::Replied(rep) if rep.from == "sub-a" && rep.id == "9"));
}

#[tokio::test]
async fn notify_broadcast_and_one_of_without_double_delivery() {
    let Some(s) = start(14305) else { return };
    struct Count(Arc<Mutex<Vec<String>>>, &'static str);
    #[async_trait]
    impl Handler for Count {
        async fn handle(&self, e: &Envelope) -> Option<HandlerResult> { self.0.lock().unwrap().push(format!("{}:{}", self.1, e.id)); allow() }
    }
    let log = Arc::new(Mutex::new(vec![]));
    let _a = plugin(&s.url, "sub-a", Arc::new(Count(log.clone(), "a"))).await;
    let _b = plugin(&s.url, "sub-b", Arc::new(Count(log.clone(), "b"))).await;
    let _c = plugin(&s.url, "sub-c", Arc::new(Count(log.clone(), "c"))).await;
    let d = core(&s.url).await;
    d.subscribe(sub("sub-a", "user.created", false, None)).unwrap(); // broadcast
    d.subscribe(sub("sub-b", "user.created", false, Some("mail"))).unwrap(); // one of "mail"
    d.subscribe(sub("sub-c", "user.created", false, Some("mail"))).unwrap();
    for i in 0..4 { d.notify(&env(&i.to_string(), "user.created")).await.unwrap(); }
    let l = log.lock().unwrap().clone();
    assert_eq!(l.iter().filter(|x| x.starts_with("a:")).count(), 4, "broadcast reaches every event");
    for i in 0..4 { assert_eq!(l.iter().filter(|x| (x.starts_with("b:") || x.starts_with("c:")) && x.ends_with(&format!(":{i}"))).count(), 1, "exactly one of the group per event {i}: {l:?}"); }
}

/// Redelivery (same envelope sent twice, as after a timeout retry or a local + NATS duplicate): the executor's effect ledger
/// makes the real effect happen once. Scope: in memory, one process. Crash/restart is NOT covered here.
#[tokio::test]
async fn same_effect_key_twice_runs_the_effect_once() {
    let Some(s) = start(14306) else { return };
    struct Exec(EffectLedger, Arc<Mutex<u32>>);
    #[async_trait]
    impl Handler for Exec {
        async fn handle(&self, e: &Envelope) -> Option<HandlerResult> {
            if self.0.first_time(e.effect_key.as_deref()?) { *self.1.lock().unwrap() += 1; }
            allow()
        }
    }
    let n = Arc::new(Mutex::new(0));
    let _a = plugin(&s.url, "sub-a", Arc::new(Exec(EffectLedger::new(), n.clone()))).await;
    let d = core(&s.url).await;
    d.subscribe(sub("sub-a", "user.created", false, None)).unwrap();
    let e = Envelope::new("m1", "user.created", json!({})).with_effect_key("effect-123");
    d.notify(&e).await.unwrap();
    d.notify(&e).await.unwrap();
    d.notify(&Envelope::new("m2", "user.created", json!({})).with_effect_key("effect-456")).await.unwrap();
    assert_eq!(*n.lock().unwrap(), 2);
}
