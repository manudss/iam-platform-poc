use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What travels on the bus. `tenant` is a reserved field (D11): carried, never interpreted in the POC.
/// `effect_key` identifies one real-world effect; executors must dedupe on it (a bus-level dedup is not enough).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Envelope {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_key: Option<String>,
    #[serde(default)]
    pub payload: Value,
}

impl Envelope {
    pub fn new(id: impl Into<String>, kind: impl Into<String>, payload: Value) -> Self {
        Envelope { id: id.into(), kind: kind.into(), tenant: None, effect_key: None, payload }
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
}
