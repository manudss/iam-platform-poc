//! Event bus of the Rust core (plan step 1). The core owns the bus (D1/D2): emitters call a core method,
//! the core checks the catalogue, finds the subscriptions, delivers, merges and answers.
//! Transport is behind a trait: `InProcTransport` (tests) and `NatsTransport` (real NATS, D14/D16).
//! Not in this step: plugin host v2, API protocol, JetStream consumers, journal plugin, AppEvents (PR #7).
pub mod catalogue;
pub mod dispatcher;
pub mod envelope;
pub mod handler;
pub mod nats;
pub mod registry;
pub mod transport;

pub use catalogue::{Catalogue, Mode};
pub use dispatcher::{CallOutcome, Dispatcher, MergedData, SubOutcome, SubStatus};
pub use envelope::{Envelope, Reply, Verdict};
pub use handler::{EffectLedger, Handler, HandlerResult, WasmHandler};
pub use registry::{Registry, Subscription};
pub use transport::{InProcTransport, Transport, TransportError};

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum BusError {
    UnknownKind(String),
    WrongMode { kind: String, expected: Mode },
    InvalidSubscription(String),
}
impl std::fmt::Display for BusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for BusError {}
