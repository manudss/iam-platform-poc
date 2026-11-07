use crate::envelope::{Envelope, Reply, Verdict};
use async_trait::async_trait;
use iam_plugin_runtime::{PluginRuntime, Verdict as WasmVerdict};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Default, PartialEq)]
pub struct HandlerResult { pub verdict: Option<Verdict>, pub data: Option<Value> }
/// A handler may also answer "not concerned" (disabled for this branch): the host turns it into a reply flag.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HandlerOutcome { pub result: Option<HandlerResult>, pub not_concerned: bool }

/// A subscriber's code. `None` = stays silent (no reply at all).
#[async_trait]
pub trait Handler: Send + Sync {
    async fn handle(&self, env: &Envelope) -> Option<HandlerResult>;
}

/// The `from` field is always set by the host from the subscriber id, never by the handler.
pub async fn reply_bytes(id: &str, h: &dyn Handler, env: &Envelope) -> Option<Vec<u8>> {
    let r = h.handle(env).await?;
    serde_json::to_vec(&Reply { from: id.to_string(), id: env.id.clone(), verdict: r.verdict, data: r.data, not_concerned: false }).ok()
}

/// WASM subscriber wired to the existing v0 runtime: payload `{"hour": n, "sensitive": bool}` -> allow/deny.
/// Any runtime error (trap, out of fuel, bad payload) = silent, so a mandatory control refuses (fail closed).
pub struct WasmHandler { rt: Arc<PluginRuntime>, wasm: Arc<Vec<u8>> }
impl WasmHandler {
    pub fn new(rt: Arc<PluginRuntime>, wasm: Vec<u8>) -> Self { Self { rt, wasm: Arc::new(wasm) } }
}
#[async_trait]
impl Handler for WasmHandler {
    async fn handle(&self, env: &Envelope) -> Option<HandlerResult> {
        let hour = env.payload.get("hour")?.as_i64()? as i32;
        let sensitive = env.payload.get("sensitive")?.as_bool()?;
        let (rt, wasm) = (self.rt.clone(), self.wasm.clone());
        let v = tokio::task::spawn_blocking(move || rt.run(&wasm, hour, sensitive)).await.ok()?.ok()?;
        Some(HandlerResult { verdict: Some(match v { WasmVerdict::Allow => Verdict::Allow, WasmVerdict::Deny => Verdict::Deny }), data: None })
    }
}

/// Executor-side idempotency: an effect with a given effect key runs at most once per ledger.
/// Bus-level dedup does not replace it (redelivery, expiry, local + NATS paths). In memory only in step 1:
/// it does NOT survive a restart (a durable ledger belongs to the later effects step).
#[derive(Default, Clone)]
pub struct EffectLedger(Arc<Mutex<HashSet<String>>>);
impl EffectLedger {
    pub fn new() -> Self { Self::default() }
    /// True when the key is new (the caller must run the effect), false when it was already seen.
    pub fn first_time(&self, key: &str) -> bool { self.0.lock().unwrap().insert(key.to_string()) }
}
