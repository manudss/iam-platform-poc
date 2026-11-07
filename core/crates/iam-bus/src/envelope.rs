use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What travels on the bus. `tenant` is a reserved field (D11): carried, never interpreted in the POC.
/// `branch` is the Dolt working branch the event belongs to (step 3): carried exactly like `tenant`, never
/// interpreted by the core; hosts use it to serve the delivery from that branch's registry.
/// `effect_key` identifies one real-world effect; executors must dedupe on it (a bus-level dedup is not enough).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_key: Option<String>,
    #[serde(default)]
    pub payload: Value,
    /// Who sent the event: stamped by the core when it accepts an external emission (`api` or `plugin:<id>`).
    /// Absent for events the core emits itself. Never trusted from the caller: the core overwrites it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl Envelope {
    pub fn new(id: impl Into<String>, kind: impl Into<String>, payload: Value) -> Self {
        Envelope { id: id.into(), kind: kind.into(), tenant: None, branch: None, effect_key: None, payload, source: None }
    }
    pub fn with_effect_key(mut self, k: impl Into<String>) -> Self { self.effect_key = Some(k.into()); self }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict { Allow, Deny }

/// A subscriber's answer. The core checks `from` against the subscriber it asked and `id` against the envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    pub from: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// "Not concerned by this event" (step 3): a plugin disabled on the envelope's branch says so explicitly.
    /// It counts neither as an answer (no verdict, no data) nor as silence: a mandatory subscriber that is
    /// not concerned does NOT refuse the call. Silence (no reply at all) keeps the D3 meaning.
    #[serde(default)]
    pub not_concerned: bool,
}
