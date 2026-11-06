//! Optional wiring of the event bus. Off unless IAM_CORE_NATS_URL is set. When on, the core connects to NATS, tells the bus
//! about real events (activation applied, sign-in succeeded/refused: notifications only, no decision depends on them) and keeps
//! a bounded, MASKED record of every exchange for the read-only observer (`GET /v1/bus/records`, admin token).
//! Step 3: Notify deliveries are durably queued in JetStream (stream IAM_BUS_EVENTS, at-least-once) and every observer
//! record is also persisted to the IAM_BUS_JOURNAL stream (survives the core; the HTTP feed still reads the fast ring).
//! `GET /v1/bus` runs a LIVE self-test through NATS. Existing behaviour (decisions, activation, IdP, gRPC) is unchanged.
use axum::{Json, extract::{Query, State}, http::{HeaderMap, StatusCode}};
use iam_bus::{BusRecord, Catalogue, Dispatcher, Envelope, Handler, HandlerResult, Mode, Observer, SubStatus, Subscription, Verdict, nats};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

const RING: usize = 500;
const NOTIFY_KINDS: [&str; 5] = ["activation.applied", "signin.succeeded", "signin.refused", "access.decided", "policy.admin"];

/// Bounded in-memory record, numbered. The HTTP feed reads this fast ring; the same records are also persisted
/// to the IAM_BUS_JOURNAL JetStream stream (step 3), which a later step re-reads after a restart.
#[derive(Default)]
pub struct Ring { buf: Mutex<VecDeque<(u64, BusRecord)>>, next: Mutex<u64> }
impl Observer for Ring {
    fn record(&self, r: &BusRecord) {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        let mut b = self.buf.lock().unwrap();
        b.push_back((*n, r.clone()));
        if b.len() > RING { b.pop_front(); }
    }
}
/// Persists every record to the journal stream (fire and forget: observation must never slow the bus down).
struct Journal { js: async_nats::jetstream::Context }
impl Observer for Journal {
    fn record(&self, r: &BusRecord) {
        if let Ok(body) = serde_json::to_vec(r) {
            let js = self.js.clone();
            tokio::spawn(async move { let _ = js.publish(nats::JOURNAL_SUBJECT, body.into()).await; });
        }
    }
}

impl Ring {
    /// Replay from the durable journal after a restart: records keep their order, get fresh ring seqs.
    fn load(&self, r: BusRecord) {
        let mut n = self.next.lock().unwrap();
        *n += 1;
        let mut b = self.buf.lock().unwrap();
        b.push_back((*n, r));
        if b.len() > RING { b.pop_front(); }
    }
    fn since(&self, after: u64, limit: usize) -> (Vec<Value>, u64, u64) {
        let b = self.buf.lock().unwrap();
        let first = b.front().map(|x| x.0).unwrap_or(0);
        let last = b.back().map(|x| x.0).unwrap_or(0);
        (b.iter().filter(|(s, _)| *s > after).take(limit).map(|(s, r)| view(*s, r)).collect(), first, last)
    }
}

fn view(seq: u64, r: &BusRecord) -> Value {
    json!({
        "seq": seq, "at_ms": r.at_ms, "envelope_id": r.envelope_id, "kind": r.kind,
        "mode": format!("{:?}", r.mode).to_lowercase(), "tenant": r.tenant, "branch": r.branch, "effect_key": r.effect_key, "source": r.source,
        "payload": r.payload, "elapsed_ms": r.elapsed_ms, "verdict": r.verdict,
        // who was expected to answer, and what each one did
        "expected": r.outcomes.iter().map(|o| json!({"id": o.subscriber, "mandatory": o.mandatory})).collect::<Vec<_>>(),
        "outcomes": r.outcomes.iter().map(|o| match &o.status {
            SubStatus::Replied(rep) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "replied", "verdict": rep.verdict, "data_keys": rep.data.as_ref().and_then(|d| d.as_object()).map(|m| m.keys().cloned().collect::<Vec<_>>())}),
            SubStatus::Queued => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "queued", "detail": "stored in JetStream; delivery is at-least-once, the consumer acks after processing"}),
            SubStatus::NotConcerned => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "not-concerned", "detail": "disabled on the envelope's branch (or not concerned): neither an answer nor silence"}),
            SubStatus::Silent(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "silent", "detail": why}),
            SubStatus::Invalid(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "invalid", "detail": why.chars().take(80).collect::<String>()}),
        }).collect::<Vec<_>>(),
    })
}

pub struct BusLink {
    dispatcher: Arc<Dispatcher>, ring: Arc<Ring>, errors: nats::ServerErrors, url: String, cache: Mutex<Option<(std::time::Instant, Value)>>,
    /// Step 2: what the control plane registered per plugin (deliveries + emission grants). In memory only:
    /// a core restart forgets them; the API host re-pushes its registrations (idempotent, replaces the set).
    hosts: RwLock<HashMap<String, HostGrants>>,
}

struct Ack;
#[async_trait::async_trait]
impl Handler for Ack {
    async fn handle(&self, _e: &Envelope) -> Option<HandlerResult> { Some(HandlerResult { verdict: Some(Verdict::Allow), data: None }) }
}

impl BusLink {
    pub async fn connect(url: &str, user: &str, pass: &str) -> Result<Self, String> {
        // nats-server may still be starting (slow host): retry for a bounded time, then give up with an explicit error.
        // After the first connection async-nats reconnects by itself; while it is down a mandatory control is refused (fail closed).
        let started = std::time::Instant::now();
        let (client, errors) = loop {
            match nats::connect(url, user, pass, None).await {
                Ok(c) => break c,
                Err(e) if started.elapsed() < Duration::from_secs(20) => { tracing::info!("waiting for NATS: {e}"); tokio::time::sleep(Duration::from_millis(500)).await; }
                Err(e) => return Err(e),
            }
        };
        // Durable bus storage first: without it there is no at-least-once delivery, so the core refuses to start
        // (same rule as NATS down: the bus is a base process, not a degraded mode).
        nats::ensure_bus_streams(&client).await?;
        // Control/query subscribers hosted by the core are reached through request/reply (D16).
        nats::serve(client.clone(), "core-selftest", Arc::new(Ack)).await?;
        // Notify subscribers hosted by the core pull their durable deliveries from JetStream.
        nats::serve_events(client.clone(), "audit-log", Arc::new(Ack)).await?;
        let mut cat = Catalogue::new().declare("core.selftest", Mode::Control);
        for k in NOTIFY_KINDS { cat = cat.declare(k, Mode::Notify); }
        let d = Dispatcher::new(cat, Arc::new(nats::NatsTransport::new(client.clone())), Duration::from_millis(500));
        let ring = Arc::new(Ring::default());
        d.observe(ring.clone());
        d.observe(Arc::new(Journal { js: async_nats::jetstream::new(client.clone()) }));
        let sub = |id: &str, kind: &str, mandatory: bool| Subscription { subscriber: id.into(), kind: kind.into(), mandatory, group: None };
        d.subscribe(sub("core-selftest", "core.selftest", true)).map_err(|e| e.to_string())?;
        d.subscribe(sub("core-absent", "core.selftest", false)).map_err(|e| e.to_string())?;
        for k in NOTIFY_KINDS { d.subscribe(sub("audit-log", k, false)).map_err(|e| e.to_string())?; }
        // activation.applied also has a subscriber that is never started: the observer must show "expected, silent".
        d.subscribe(sub("mail-notifier", "activation.applied", false)).map_err(|e| e.to_string())?;
        // Restart-proof observer (step 3): the IAM_BUS_JOURNAL stream survives the core; replay its last RING
        // records into the ring so the HTTP feed keeps its history across a restart. Records are renumbered in
        // replay order; the feed's first_seq makes the new numbering explicit. Best effort: a replay failure
        // never blocks the bus (the ring simply starts empty, as before).
        {
            let js = async_nats::jetstream::new(client.clone());
            if let Ok(mut stream) = js.get_stream(nats::JOURNAL_STREAM).await {
                let (first, last) = stream.info().await.map(|i| (i.state.first_sequence, i.state.last_sequence)).unwrap_or((1, 0));
                if last >= first {
                    let start = std::cmp::max(first, last.saturating_sub(RING as u64 - 1));
                    let cfg = async_nats::jetstream::consumer::pull::Config {
                        deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::ByStartSequence { start_sequence: start },
                        ack_policy: async_nats::jetstream::consumer::AckPolicy::None,
                        ..Default::default()
                    };
                    if let Ok(cons) = stream.create_consumer(cfg).await {
                        if let Ok(mut batch) = cons.fetch().max_messages(RING).messages().await {
                            use tokio_stream::StreamExt;
                            while let Some(Ok(m)) = batch.next().await {
                                if let Ok(r) = serde_json::from_slice::<BusRecord>(&m.message.payload) { ring.load(r); }
                            }
                        }
                    }
                }
            }
        }
        Ok(BusLink { dispatcher: Arc::new(d), ring, errors, url: url.to_string(), cache: Mutex::new(None), hosts: RwLock::new(HashMap::new()) })
    }
    /// Fire and forget: the caller never waits for the bus and never sees its errors.
    pub fn emit(&self, kind: &'static str, payload: Value, effect_key: Option<String>) {
        let d = self.dispatcher.clone();
        let id = format!("evt-{}", uuid_like());
        tokio::spawn(async move {
            let mut e = Envelope::new(id, kind, payload);
            e.effect_key = effect_key;
            // Fire and forget for the caller, but never silent: a queueing failure breaks at-least-once, so log it loud.
            if let Err(e) = d.notify(&e).await { tracing::warn!("bus emit of kind '{kind}' was not durably queued: {e}"); }
        });
    }
    async fn selftest(&self) -> Value {
        let t = std::time::Instant::now();
        let r = self.dispatcher.call(&Envelope::new(format!("selftest-{}", uuid_like()), "core.selftest", json!({})), None).await;
        match r {
            Ok(o) => json!({
                "verdict": o.verdict, "elapsed_ms": t.elapsed().as_millis() as u64,
                "subscribers": o.outcomes.iter().map(|x| json!({"id": x.subscriber, "mandatory": x.mandatory, "status": format!("{:?}", x.status).chars().take(60).collect::<String>()})).collect::<Vec<_>>(),
                "note": "core-selftest answers via NATS; core-absent (optional, nobody listening) is ignored"
            }),
            Err(e) => json!({"error": e.to_string()}),
        }
    }
}

fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{t:x}-{:x}", N.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn is_admin(c: &crate::Core, headers: &HeaderMap) -> bool {
    match (&c.admin_token, headers.get("x-core-admin-token").and_then(|v| v.to_str().ok())) {
        (Some(want), Some(got)) => want.len() == got.len() && want.bytes().zip(got.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0,
        _ => false,
    }
}

/// Public view: enabled + verdict + latency only (no subscriber ids, no address, no counters). The detailed view needs the
/// same admin token as /v1/activate. The self-test only talks to the core's own `core-selftest` subscriber (no user effect)
/// and its result is cached for 5 s so repeated calls cannot flood NATS.
pub async fn status(State(c): State<Arc<crate::Core>>, headers: HeaderMap) -> Json<Value> {
    let Some(b) = &c.bus else { return Json(json!({"enabled": false})) };
    let cached = b.cache.lock().unwrap().as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(5)).map(|(_, v)| v.clone());
    let st = match cached { Some(v) => v, None => { let v = b.selftest().await; *b.cache.lock().unwrap() = Some((std::time::Instant::now(), v.clone())); v } };
    if is_admin(&c, &headers) {
        Json(json!({"enabled": true, "nats": b.url, "selftest": st, "server_errors": b.errors.lock().unwrap().len()}))
    } else {
        Json(json!({"enabled": true, "selftest": {"verdict": st["verdict"], "elapsed_ms": st["elapsed_ms"]}}))
    }
}

/// Read-only observer feed. Admin token required. Never replays, never emits, never answers: it only reads the ring.
/// `after` = last seq already seen; `first_seq` tells the reader when older records were dropped (no silent gap).
pub async fn records(State(c): State<Arc<crate::Core>>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    if !is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let Some(b) = &c.bus else { return (StatusCode::OK, Json(json!({"enabled": false, "records": []}))) };
    let after = q.get("after").and_then(|v| v.parse().ok()).unwrap_or(0u64);
    let limit = q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(200usize).clamp(1, 500);
    let (records, first, last) = b.ring.since(after, limit);
    (StatusCode::OK, Json(json!({"enabled": true, "records": records, "first_seq": first, "last_seq": last, "capacity": RING, "note": "ring in memory, refilled from the durable journal on restart; payloads are masked"})))
}

// ---------- Step 2: plugin host protocol ----------
// The core owns the bus (D1/D2). The API host (or a plugin, later) asks the core over HTTP, with the admin token:
//   POST /v1/bus/plugins/register   push a plugin's deliveries (subscriptions) and emission grants
//   POST /v1/bus/plugins/unregister remove them
//   GET  /v1/bus/plugins            list what is registered
//   POST /v1/bus/emit               emit one event; the core checks the emission grant and stamps `source` itself
// Plugins receive their deliveries over NATS (`plugin.<id>.call`) and answer like any step-1 subscriber.

/// Kinds owned by the core itself: an external emitter never sends nor declares them (they report core-internal facts).
/// Step 3: external subscribers MAY subscribe to the core-emitted ones (the activation effects and the audit
/// trail live outside the core); `core.selftest` stays fully private.
const CORE_KINDS: [&str; 6] = ["core.selftest", "activation.applied", "signin.succeeded", "signin.refused", "access.decided", "policy.admin"];
/// Core-owned kinds an external plugin may subscribe to (never emit, never declare).
const CORE_EMITTED_SUBSCRIBABLE: [&str; 5] = ["activation.applied", "signin.succeeded", "signin.refused", "access.decided", "policy.admin"];
/// Subscriber ids hosted inside the core: an external plugin never takes one (its answers would be trusted as the core's).
const INTERNAL_IDS: [&str; 3] = ["core-selftest", "audit-log", "mail-notifier"];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SubDecl { pub kind: String, #[serde(default)] pub mandatory: bool, #[serde(default)] pub group: Option<String> }
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KindDecl { pub name: String, pub mode: String }

/// What the control plane pushed for one plugin: its deliveries (subscriptions) and its emission grants.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct HostGrants { pub subscriptions: Vec<SubDecl>, pub emits: Vec<String> }

fn valid_id(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') }
fn valid_kind(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') }
fn parse_mode(s: &str) -> Result<Mode, String> {
    match s { "notify" => Ok(Mode::Notify), "control" => Ok(Mode::Control), "query" => Ok(Mode::Query), _ => Err(format!("unknown mode '{s}'")) }
}

/// Validates one registration against the catalogue (plus its new kind declarations). Pure: no state change.
fn validate_register(cat: &Catalogue, plugin: &str, subs: &[SubDecl], emits: &[String], declares: &[KindDecl]) -> Result<(), String> {
    if !valid_id(plugin) || plugin.starts_with("core-") || INTERNAL_IDS.contains(&plugin) {
        return Err(format!("plugin id '{plugin}' is invalid or reserved"));
    }
    for d in declares {
        if !valid_kind(&d.name) { return Err(format!("invalid kind name '{}'", d.name)); }
        // A plugin declares kinds only inside its own namespace; the API host (control plane) declares platform kinds.
        if plugin != "api" && !d.name.starts_with(&format!("plg.{plugin}.")) {
            return Err(format!("kind '{}' is outside the plugin's namespace plg.{plugin}.*", d.name));
        }
        if CORE_KINDS.contains(&d.name.as_str()) { return Err(format!("kind '{}' is owned by the core", d.name)); }
        let mode = parse_mode(&d.mode)?;
        if let Ok(existing) = cat.mode(&d.name) {
            if existing != mode { return Err(format!("kind '{}' already declared with another mode", d.name)); }
        }
    }
    let known = |k: &str| cat.mode(k).is_ok() || declares.iter().any(|d| d.name == k);
    let mode_of = |k: &str| cat.mode(k).ok().or_else(|| declares.iter().find(|d| d.name == k).and_then(|d| parse_mode(&d.mode).ok()));
    for s in subs {
        if !known(&s.kind) { return Err(format!("unknown kind '{}'", s.kind)); }
        if CORE_KINDS.contains(&s.kind.as_str()) && !CORE_EMITTED_SUBSCRIBABLE.contains(&s.kind.as_str()) {
            return Err(format!("kind '{}' is core-internal", s.kind));
        }
        match mode_of(&s.kind) {
            Some(Mode::Notify) => if s.mandatory { return Err(format!("mandatory does not apply to notify kind '{}'", s.kind)); },
            Some(_) => if s.group.is_some() { return Err(format!("one-of groups only apply to notify kinds ('{}')", s.kind)); },
            None => return Err(format!("unknown kind '{}'", s.kind)),
        }
        if let Some(g) = &s.group { if !valid_id(g) { return Err(format!("invalid group name '{g}'")); } }
    }
    for e in emits {
        if !known(e) { return Err(format!("unknown kind '{e}'")); }
        if CORE_KINDS.contains(&e.as_str()) { return Err(format!("kind '{e}' is owned by the core")); }
    }
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct RegisterReq {
    plugin: String,
    #[serde(default)] subscriptions: Vec<SubDecl>,
    #[serde(default)] emits: Vec<String>,
    #[serde(default)] declare_kinds: Vec<KindDecl>,
}

/// Registers (or re-registers: the new set replaces the old one) a plugin's deliveries and emission grants.
pub async fn register(State(c): State<Arc<crate::Core>>, headers: HeaderMap, Json(r): Json<RegisterReq>) -> (StatusCode, Json<Value>) {
    if !is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let Some(b) = &c.bus else { return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "bus disabled"}))); };
    if let Err(e) = validate_register(b.dispatcher.catalogue(), &r.plugin, &r.subscriptions, &r.emits, &r.declare_kinds) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": e})));
    }
    for d in &r.declare_kinds {
        if let Err(e) = b.dispatcher.catalogue().try_declare(&d.name, parse_mode(&d.mode).expect("validated above")) {
            return (StatusCode::CONFLICT, Json(json!({"error": e})));
        }
    }
    // Replace the delivery set: drop this plugin's old subscriptions only, then add the new ones.
    b.dispatcher.unsubscribe(&r.plugin);
    for s in &r.subscriptions {
        if let Err(e) = b.dispatcher.subscribe(Subscription { subscriber: r.plugin.clone(), kind: s.kind.clone(), mandatory: s.mandatory, group: s.group.clone() }) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e.to_string()})));
        }
    }
    let grants = HostGrants { subscriptions: r.subscriptions.clone(), emits: r.emits.clone() };
    b.hosts.write().unwrap().insert(r.plugin.clone(), grants.clone());
    (StatusCode::OK, Json(json!({ "plugin": r.plugin, "subscriptions": grants.subscriptions, "emits": grants.emits })))
}

#[derive(serde::Deserialize)]
pub struct UnregisterReq { plugin: String }

/// Removes a plugin's deliveries and grants. Idempotent: removing an unknown plugin succeeds.
pub async fn unregister(State(c): State<Arc<crate::Core>>, headers: HeaderMap, Json(r): Json<UnregisterReq>) -> (StatusCode, Json<Value>) {
    if !is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let Some(b) = &c.bus else { return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "bus disabled"}))); };
    b.dispatcher.unsubscribe(&r.plugin);
    b.hosts.write().unwrap().remove(&r.plugin);
    (StatusCode::OK, Json(json!({ "plugin": r.plugin, "removed": true })))
}

/// What is registered right now (in memory; lost on core restart).
pub async fn plugins(State(c): State<Arc<crate::Core>>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let Some(b) = &c.bus else { return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "bus disabled"}))); };
    (StatusCode::OK, Json(json!({ "plugins": b.hosts.read().unwrap().iter().collect::<HashMap<_, _>>() })))
}

#[derive(serde::Deserialize)]
pub struct EmitReq {
    source: String,
    kind: String,
    #[serde(default)] payload: Value,
    #[serde(default)] tenant: Option<String>,
    /// Working branch the event belongs to (step 3): carried, never interpreted (like the tenant).
    #[serde(default)] branch: Option<String>,
    #[serde(default)] effect_key: Option<String>,
    #[serde(default)] timeout_ms: Option<u64>,
}

fn outcomes_json(outcomes: &[iam_bus::SubOutcome]) -> Value {
    outcomes.iter().map(|o| match &o.status {
        SubStatus::Replied(r) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "replied", "verdict": r.verdict, "data": r.data}),
        SubStatus::Queued => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "queued"}),
        SubStatus::NotConcerned => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "not-concerned"}),
        SubStatus::Silent(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "silent", "detail": why}),
        SubStatus::Invalid(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "invalid", "detail": why}),
    }).collect()
}

/// One emission on the bus, requested by the API host or by a plugin. The core checks the emission grant, stamps
/// `source` on the envelope itself (the caller cannot forge it) and dispatches by the kind's mode.
pub async fn emit_http(State(c): State<Arc<crate::Core>>, headers: HeaderMap, Json(r): Json<EmitReq>) -> (StatusCode, Json<Value>) {
    if !is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let Some(b) = &c.bus else { return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "bus disabled"}))); };
    if r.source != "api" {
        let Some(id) = r.source.strip_prefix("plugin:") else {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": "source must be 'api' or 'plugin:<id>'"})));
        };
        let granted = b.hosts.read().unwrap().get(id).map(|g| g.emits.iter().any(|k| k == &r.kind)).unwrap_or(false);
        if !granted { return (StatusCode::FORBIDDEN, Json(json!({"error": format!("plugin '{id}' has no emission grant for '{}'", r.kind)}))); }
    }
    if CORE_KINDS.contains(&r.kind.as_str()) { return (StatusCode::FORBIDDEN, Json(json!({"error": format!("kind '{}' is owned by the core", r.kind)}))); }
    let mode = match b.dispatcher.catalogue().mode(&r.kind) { Ok(m) => m, Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("unknown kind '{}'", r.kind)}))) };
    let mut env = Envelope::new(format!("http-{}", uuid_like()), &r.kind, r.payload);
    env.tenant = r.tenant; env.branch = r.branch; env.effect_key = r.effect_key; env.source = Some(r.source.clone());
    match mode {
        Mode::Notify => match b.dispatcher.notify(&env).await {
            Ok(o) => (StatusCode::OK, Json(json!({"mode": "notify", "outcomes": outcomes_json(&o)}))),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": e.to_string()}))),
        },
        Mode::Control => match b.dispatcher.call(&env, r.timeout_ms.map(Duration::from_millis)).await {
            Ok(o) => (StatusCode::OK, Json(json!({"mode": "control", "verdict": o.verdict, "reason": o.reason, "outcomes": outcomes_json(&o.outcomes)}))),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": e.to_string()}))),
        },
        Mode::Query => match b.dispatcher.query(&env, r.timeout_ms.map(Duration::from_millis)).await {
            Ok(m) => (StatusCode::OK, Json(json!({"mode": "query", "data": m.data, "conflicts": m.conflicts, "refused": m.refused, "outcomes": outcomes_json(&m.outcomes)}))),
            Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({"error": e.to_string()}))),
        },
    }
}

#[cfg(test)]
mod step2_validation_tests {
    use super::*;
    fn cat() -> Catalogue { Catalogue::new().declare("notify.send", Mode::Notify).declare("auth.check", Mode::Control) }
    fn sub(kind: &str, mandatory: bool, group: Option<&str>) -> SubDecl { SubDecl { kind: kind.into(), mandatory, group: group.map(Into::into) } }
    fn decl(name: &str, mode: &str) -> KindDecl { KindDecl { name: name.into(), mode: mode.into() } }

    #[test]
    fn reserved_ids_and_core_kinds_are_refused() {
        let c = cat();
        assert!(validate_register(&c, "core-x", &[], &[], &[]).is_err());
        assert!(validate_register(&c, "audit-log", &[], &[], &[]).is_err());
        assert!(validate_register(&c, "bad id!", &[], &[], &[]).is_err());
        assert!(validate_register(&c, "notify-log", &[sub("core.selftest", false, None)], &[], &[]).is_err(), "core-internal subscribe");
        assert!(validate_register(&c, "notify-log", &[], &["signin.succeeded".into()], &[]).is_err(), "core-owned emit");
        assert!(validate_register(&c, "notify-log", &[], &[], &[decl("signin.refused", "notify")]).is_err(), "core-owned declare");
    }

    #[test]
    fn mode_rules_follow_the_kind() {
        let c = cat();
        assert!(validate_register(&c, "notify-log", &[sub("notify.send", true, None)], &[], &[]).is_err(), "mandatory on notify");
        assert!(validate_register(&c, "notify-log", &[sub("auth.check", false, Some("g"))], &[], &[]).is_err(), "group on control");
        assert!(validate_register(&c, "notify-log", &[sub("nope", false, None)], &[], &[]).is_err(), "unknown kind");
        assert!(validate_register(&c, "notify-log", &[sub("notify.send", false, Some("mail"))], &[], &[]).is_ok());
        assert!(validate_register(&c, "notify-log", &[sub("auth.check", true, None)], &[], &[]).is_ok());
    }

    #[test]
    fn declares_stay_in_the_plugins_namespace() {
        let c = cat();
        assert!(validate_register(&c, "notify-log", &[], &[], &[decl("other.thing", "notify")]).is_err());
        assert!(validate_register(&c, "notify-log", &[], &["plg.notify-log.ping".into()], &[decl("plg.notify-log.ping", "notify")]).is_ok());
        // the API host declares platform kinds without a namespace restriction
        assert!(validate_register(&c, "api", &[], &[], &[decl("notify.send", "notify")]).is_ok());
        assert!(validate_register(&c, "api", &[], &[], &[decl("notify.send", "control")]).is_err(), "mode change refused");
        assert!(validate_register(&c, "api", &[], &[], &[decl("x", "yell")]).is_err(), "unknown mode");
    }
}
