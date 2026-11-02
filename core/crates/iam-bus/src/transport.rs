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
