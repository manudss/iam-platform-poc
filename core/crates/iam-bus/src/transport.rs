use crate::envelope::Envelope;
use crate::handler::{Handler, reply_bytes};
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError { Timeout, NoResponder, Other(String) }

/// One request to one subscriber; returns the raw reply bytes. A silent subscriber is `Timeout`.
#[async_trait]
pub trait Transport: Send + Sync {
    async fn request(&self, subscriber: &str, body: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, TransportError>;
    /// Notify delivery (step 3): durably queue the event for `subscriber` (a subscriber id or a group name).
    /// Ok means at-least-once storage is confirmed (JetStream publish ack). The default keeps old test
    /// transports compiling: they support no queue, so every notify they carry is refused.
    async fn queue(&self, subscriber: &str, _body: Vec<u8>, _timeout: Duration) -> Result<(), TransportError> {
        let _ = subscriber;
        Err(TransportError::Other("this transport has no durable queue".into()))
    }
}

/// In-process transport for tests: same wire format (JSON bytes) as NATS, no network.
#[derive(Default)]
pub struct InProcTransport {
    handlers: RwLock<HashMap<String, Arc<dyn Handler>>>,
    down: RwLock<HashSet<String>>,
}
impl InProcTransport {
    pub fn new() -> Self { Self::default() }
    pub fn register(&self, id: &str, h: Arc<dyn Handler>) { self.handlers.write().unwrap().insert(id.into(), h); }
    pub fn set_down(&self, id: &str, down: bool) {
        let mut d = self.down.write().unwrap();
        if down { d.insert(id.into()); } else { d.remove(id); }
    }
}
#[async_trait]
impl Transport for InProcTransport {
    /// In memory there is no broker to hold the event: "queued" means the handler ran inline, right now.
    /// An unknown subscriber mirrors the JetStream case (a delivery address nobody consumes yet): the event
    /// is accepted and simply never processed.
    async fn queue(&self, subscriber: &str, body: Vec<u8>, _timeout: Duration) -> Result<(), TransportError> {
        let Some(h) = self.handlers.read().unwrap().get(subscriber).cloned() else { return Ok(()) };
        if self.down.read().unwrap().contains(subscriber) { return Err(TransportError::Other("subscriber down".into())); }
        let env: Envelope = serde_json::from_slice(&body).map_err(|e| TransportError::Other(e.to_string()))?;
        let _ = reply_bytes(subscriber, h.as_ref(), &env).await;
        Ok(())
    }
    async fn request(&self, subscriber: &str, body: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, TransportError> {
        let h = self.handlers.read().unwrap().get(subscriber).cloned().ok_or(TransportError::NoResponder)?;
        if self.down.read().unwrap().contains(subscriber) { tokio::time::sleep(timeout).await; return Err(TransportError::Timeout); }
        let env: Envelope = serde_json::from_slice(&body).map_err(|e| TransportError::Other(e.to_string()))?;
        match tokio::time::timeout(timeout, reply_bytes(subscriber, h.as_ref(), &env)).await {
            Ok(Some(b)) => Ok(b),
            Ok(None) | Err(_) => Err(TransportError::Timeout), // silent handler = missing reply
        }
    }
}
