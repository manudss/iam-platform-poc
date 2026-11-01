//! Optional wiring of the event bus (step 1). Off unless IAM_CORE_NATS_URL is set. When on, the core connects to NATS
//! and exposes `GET /v1/bus`, which runs a LIVE self-test through NATS (not a cached value). It does not touch /v1/decide,
//! activation, the IdP or gRPC: existing behaviour is unchanged. Real emitters and plugin hosting come in later steps.
use axum::{Json, extract::State};
use iam_bus::{Catalogue, Dispatcher, Envelope, Handler, HandlerResult, Mode, Subscription, Verdict, nats};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

pub struct BusLink { dispatcher: Dispatcher, errors: nats::ServerErrors, url: String, cache: std::sync::Mutex<Option<(std::time::Instant, Value)>> }

struct Allow;
#[async_trait::async_trait]
impl Handler for Allow {
    async fn handle(&self, _e: &Envelope) -> Option<HandlerResult> { Some(HandlerResult { verdict: Some(Verdict::Allow), data: None }) }
}

impl BusLink {
    pub async fn connect(url: &str, user: &str, pass: &str) -> Result<Self, String> {
        // nats-server may still be starting (slow hosts): retry for a bounded time, then give up with an explicit error.
        // After the first connection async-nats reconnects by itself; while it is down a mandatory control is refused (fail closed).
        let started = std::time::Instant::now();
        let (client, errors) = loop {
            match nats::connect(url, user, pass, None).await {
                Ok(c) => break c,
                Err(e) if started.elapsed() < Duration::from_secs(20) => { tracing::info!("waiting for NATS: {e}"); tokio::time::sleep(Duration::from_millis(500)).await; }
                Err(e) => return Err(e),
            }
        };
        // The self-test subscriber is hosted by the core itself and still reached through NATS (D16).
        nats::serve(client.clone(), "core-selftest", Arc::new(Allow)).await?;
        let cat = Catalogue::new().declare("core.selftest", Mode::Control);
        let d = Dispatcher::new(cat, Arc::new(nats::NatsTransport::new(client)), Duration::from_millis(500));
        d.subscribe(Subscription { subscriber: "core-selftest".into(), kind: "core.selftest".into(), mandatory: true, group: None }).map_err(|e| e.to_string())?;
        d.subscribe(Subscription { subscriber: "core-absent".into(), kind: "core.selftest".into(), mandatory: false, group: None }).map_err(|e| e.to_string())?;
        Ok(BusLink { dispatcher: d, errors, url: url.to_string(), cache: std::sync::Mutex::new(None) })
    }
    async fn selftest(&self) -> Value {
        let t = std::time::Instant::now();
        let r = self.dispatcher.call(&Envelope::new(format!("selftest-{}", t.elapsed().as_nanos()), "core.selftest", json!({})), None).await;
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

/// Public view: enabled + verdict + latency only (no subscriber ids, no address, no counters). The detailed view needs the
/// same admin token as /v1/activate. The self-test only talks to the core's own `core-selftest` subscriber (no user effect)
/// and its result is cached for 5 s so repeated calls cannot flood NATS.
pub async fn status(State(c): State<Arc<crate::Core>>, headers: axum::http::HeaderMap) -> Json<Value> {
    let Some(b) = &c.bus else { return Json(json!({"enabled": false})) };
    let cached = b.cache.lock().unwrap().as_ref().filter(|(t, _)| t.elapsed() < Duration::from_secs(5)).map(|(_, v)| v.clone());
    let st = match cached { Some(v) => v, None => { let v = b.selftest().await; *b.cache.lock().unwrap() = Some((std::time::Instant::now(), v.clone())); v } };
    let admin = match (&c.admin_token, headers.get("x-core-admin-token").and_then(|v| v.to_str().ok())) {
        (Some(want), Some(got)) => want.len() == got.len() && want.bytes().zip(got.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0,
        _ => false,
    };
    if admin {
        Json(json!({"enabled": true, "nats": b.url, "selftest": st, "server_errors": b.errors.lock().unwrap().len()}))
    } else {
        Json(json!({"enabled": true, "selftest": {"verdict": st["verdict"], "elapsed_ms": st["elapsed_ms"]}}))
    }
}
