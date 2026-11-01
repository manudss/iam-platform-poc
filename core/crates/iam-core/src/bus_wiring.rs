//! Optional wiring of the event bus. Off unless IAM_CORE_NATS_URL is set. When on, the core connects to NATS, tells the bus
//! about real events (activation applied, sign-in succeeded/refused: notifications only, no decision depends on them) and keeps
//! a bounded, MASKED record of every exchange for the read-only observer (`GET /v1/bus/records`, admin token).
//! `GET /v1/bus` runs a LIVE self-test through NATS. Existing behaviour (decisions, activation, IdP, gRPC) is unchanged.
use axum::{Json, extract::{Query, State}, http::{HeaderMap, StatusCode}};
use iam_bus::{BusRecord, Catalogue, Dispatcher, Envelope, Handler, HandlerResult, Mode, Observer, SubStatus, Subscription, Verdict, nats};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RING: usize = 500;
const NOTIFY_KINDS: [&str; 3] = ["activation.applied", "signin.succeeded", "signin.refused"];

/// Bounded in-memory record, numbered. In memory only: lost on restart (stated in docs/event-bus.md).
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
impl Ring {
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
        "mode": format!("{:?}", r.mode).to_lowercase(), "tenant": r.tenant, "effect_key": r.effect_key,
        "payload": r.payload, "elapsed_ms": r.elapsed_ms, "verdict": r.verdict,
        // who was expected to answer, and what each one did
        "expected": r.outcomes.iter().map(|o| json!({"id": o.subscriber, "mandatory": o.mandatory})).collect::<Vec<_>>(),
        "outcomes": r.outcomes.iter().map(|o| match &o.status {
            SubStatus::Replied(rep) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "replied", "verdict": rep.verdict, "data_keys": rep.data.as_ref().and_then(|d| d.as_object()).map(|m| m.keys().cloned().collect::<Vec<_>>())}),
            SubStatus::Silent(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "silent", "detail": why}),
            SubStatus::Invalid(why) => json!({"id": o.subscriber, "mandatory": o.mandatory, "status": "invalid", "detail": why.chars().take(80).collect::<String>()}),
        }).collect::<Vec<_>>(),
    })
}

pub struct BusLink { dispatcher: Arc<Dispatcher>, ring: Arc<Ring>, errors: nats::ServerErrors, url: String, cache: Mutex<Option<(std::time::Instant, Value)>> }

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
        // Subscribers hosted by the core itself are still reached through NATS (D16).
        nats::serve(client.clone(), "core-selftest", Arc::new(Ack)).await?;
        nats::serve(client.clone(), "audit-log", Arc::new(Ack)).await?;
        let mut cat = Catalogue::new().declare("core.selftest", Mode::Control);
        for k in NOTIFY_KINDS { cat = cat.declare(k, Mode::Notify); }
        let d = Dispatcher::new(cat, Arc::new(nats::NatsTransport::new(client)), Duration::from_millis(500));
        let ring = Arc::new(Ring::default());
        d.observe(ring.clone());
        let sub = |id: &str, kind: &str, mandatory: bool| Subscription { subscriber: id.into(), kind: kind.into(), mandatory, group: None };
        d.subscribe(sub("core-selftest", "core.selftest", true)).map_err(|e| e.to_string())?;
        d.subscribe(sub("core-absent", "core.selftest", false)).map_err(|e| e.to_string())?;
        for k in NOTIFY_KINDS { d.subscribe(sub("audit-log", k, false)).map_err(|e| e.to_string())?; }
        // activation.applied also has a subscriber that is never started: the observer must show "expected, silent".
        d.subscribe(sub("mail-notifier", "activation.applied", false)).map_err(|e| e.to_string())?;
        Ok(BusLink { dispatcher: Arc::new(d), ring, errors, url: url.to_string(), cache: Mutex::new(None) })
    }
    /// Fire and forget: the caller never waits for the bus and never sees its errors.
    pub fn emit(&self, kind: &'static str, payload: Value, effect_key: Option<String>) {
        let d = self.dispatcher.clone();
        let id = format!("evt-{}", uuid_like());
        tokio::spawn(async move {
            let mut e = Envelope::new(id, kind, payload);
            e.effect_key = effect_key;
            let _ = d.notify(&e).await;
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

fn is_admin(c: &crate::Core, headers: &HeaderMap) -> bool {
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
    (StatusCode::OK, Json(json!({"enabled": true, "records": records, "first_seq": first, "last_seq": last, "capacity": RING, "note": "in memory, lost on core restart; payloads are masked"})))
}
