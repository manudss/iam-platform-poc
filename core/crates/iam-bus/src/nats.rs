//! NATS transport (async-nats). Subject layout (step 0 spike, measured): the core calls `plugin.<id>.call`;
//! each subscriber connects as its own NATS user, may publish only `core.in.<id>`, subscribe only
//! `plugin.<id>.call` and `_INBOX.<id>.>` (custom inbox prefix), replies through allow_responses.
//! Subjects never overlap the API's JetStream stream `IAM_EVENTS` (`iam.>`).
use crate::envelope::Envelope;
use crate::handler::{Handler, reply_bytes};
use crate::transport::{Transport, TransportError};
use async_nats::{Client, ConnectOptions};
use async_trait::async_trait;
use futures::StreamExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type ServerErrors = Arc<Mutex<Vec<String>>>;

pub fn subject_for(subscriber: &str) -> String { format!("plugin.{subscriber}.call") }

/// Connects with user/password. Server-side errors (permissions violations) only show up as events in async-nats,
/// so they are collected here and must be read by the caller.
pub async fn connect(url: &str, user: &str, password: &str, inbox_prefix: Option<&str>) -> Result<(Client, ServerErrors), String> {
    let errs: ServerErrors = Arc::default();
    let e2 = errs.clone();
    let mut o = ConnectOptions::with_user_and_password(user.into(), password.into()).event_callback(move |ev| {
        let e2 = e2.clone();
        async move { if let async_nats::Event::ServerError(s) = &ev { e2.lock().unwrap().push(s.to_string()); } }
    });
    if let Some(p) = inbox_prefix { o = o.custom_inbox_prefix(p); }
    let c = o.connect(url).await.map_err(|e| format!("nats connect {user}@{url}: {e}"))?;
    Ok((c, errs))
}

pub struct NatsTransport { client: Client }
impl NatsTransport {
    pub fn new(client: Client) -> Self { Self { client } }
}
#[async_trait]
impl Transport for NatsTransport {
    async fn request(&self, subscriber: &str, body: Vec<u8>, timeout: Duration) -> Result<Vec<u8>, TransportError> {
        match tokio::time::timeout(timeout, self.client.request(subject_for(subscriber), body.into())).await {
            Err(_) => Err(TransportError::Timeout),
            Ok(Ok(m)) => Ok(m.payload.to_vec()),
            Ok(Err(e)) => match e.kind() {
                async_nats::client::RequestErrorKind::NoResponders => Err(TransportError::NoResponder),
                async_nats::client::RequestErrorKind::TimedOut => Err(TransportError::Timeout),
                _ => Err(TransportError::Other(e.to_string())),
            },
        }
    }
}

/// Subscriber side: serves `plugin.<id>.call` with a handler. Used for plugins hosted by the core (WASM, D16: the call
/// always goes through NATS) and by tests simulating external plugins. Every call runs in its own task: a slow or
/// failing call never blocks the next one.
pub async fn serve(client: Client, id: &str, handler: Arc<dyn Handler>) -> Result<tokio::task::JoinHandle<()>, String> {
    let mut sub = client.subscribe(subject_for(id)).await.map_err(|e| e.to_string())?;
    client.flush().await.map_err(|e| e.to_string())?;
    let id = id.to_string();
    Ok(tokio::spawn(async move {
        while let Some(m) = sub.next().await {
            let Some(reply_to) = m.reply.clone() else { continue };
            let (c, h, id) = (client.clone(), handler.clone(), id.clone());
            tokio::spawn(async move {
                let Ok(env) = serde_json::from_slice::<Envelope>(&m.payload) else { return };
                if let Some(b) = reply_bytes(&id, h.as_ref(), &env).await { let _ = c.publish(reply_to, b.into()).await; }
            });
        }
    }))
}
