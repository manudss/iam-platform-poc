//! NATS transport (async-nats). Subject layout (step 0 spike, measured): the core calls `plugin.<id>.call`;
//! each subscriber connects as its own NATS user, may publish only `core.in.<id>`, subscribe only
//! `plugin.<id>.call` and `_INBOX.<id>.>` (custom inbox prefix), replies through allow_responses.
//! Step 3: Notify deliveries go through JetStream. Stream `IAM_BUS_EVENTS` holds one copy per delivery
//! address (`bus.events.<id-or-group>`, work queue); a consumer acks only AFTER processing, so a crash
//! means redelivery (at-least-once). Stream `IAM_BUS_JOURNAL` (`bus.journal`) persists the observer records.
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

/// JetStream streams owned by the bus (step 3). Names are fixed: hosts know them by contract.
pub const EVENTS_STREAM: &str = "IAM_BUS_EVENTS";
pub const JOURNAL_STREAM: &str = "IAM_BUS_JOURNAL";
/// Subject of one delivery address inside EVENTS_STREAM.
pub fn event_subject(address: &str) -> String { format!("bus.events.{address}") }
pub const JOURNAL_SUBJECT: &str = "bus.journal";

/// Creates the bus streams when missing (idempotent). Needs JetStream: the server config enables it.
/// Events: work queue, one copy per delivery address, kept until consumed (bounded by age for the POC).
/// Journal: plain retention, every observer record, for the persistent audit feed.
pub async fn ensure_bus_streams(client: &Client) -> Result<(), String> {
    use async_nats::jetstream::stream::{Config, RetentionPolicy, StorageType};
    let js = async_nats::jetstream::new(client.clone());
    let events = Config {
        name: EVENTS_STREAM.into(),
        subjects: vec!["bus.events.>".into()],
        retention: RetentionPolicy::WorkQueue,
        storage: StorageType::File,
        max_age: Duration::from_secs(7 * 24 * 3600),
        ..Default::default()
    };
    js.get_or_create_stream(events).await.map_err(|e| format!("stream {EVENTS_STREAM}: {e}"))?;
    let journal = Config {
        name: JOURNAL_STREAM.into(),
        subjects: vec![JOURNAL_SUBJECT.into()],
        retention: RetentionPolicy::Limits,
        storage: StorageType::File,
        max_age: Duration::from_secs(30 * 24 * 3600),
        ..Default::default()
    };
    js.get_or_create_stream(journal).await.map_err(|e| format!("stream {JOURNAL_STREAM}: {e}"))?;
    Ok(())
}

pub struct NatsTransport { client: Client, js: async_nats::jetstream::Context }
impl NatsTransport {
    pub fn new(client: Client) -> Self { Self { js: async_nats::jetstream::new(client.clone()), client } }
}
#[async_trait]
impl Transport for NatsTransport {
    /// Durable queueing: the publish ack from JetStream is the at-least-once guarantee. No ack = failure.
    async fn queue(&self, subscriber: &str, body: Vec<u8>, timeout: Duration) -> Result<(), TransportError> {
        let pending = self.js.publish(event_subject(subscriber), body.into()).await.map_err(|e| TransportError::Other(e.to_string()))?;
        match tokio::time::timeout(timeout, pending).await {
            Ok(Ok(_ack)) => Ok(()),
            Ok(Err(e)) => Err(TransportError::Other(e.to_string())),
            Err(_) => Err(TransportError::Timeout),
        }
    }
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

/// Event consumer side (step 3): pulls durable deliveries from `EVENTS_STREAM` for one address
/// (`bus.events.<address>`, durable consumer named after the address) and runs the handler for each.
/// The message is acked only AFTER the handler ran; an unprocessable message (unreadable envelope) is
/// terminated so one poison event never blocks the queue. Several processes may pull the same durable
/// consumer (a group): NATS gives each message to exactly one of them. The reply, if any, is dropped:
/// notify deliveries have no answer.
pub async fn serve_events(client: Client, address: &str, handler: Arc<dyn Handler>) -> Result<tokio::task::JoinHandle<()>, String> {
    use async_nats::jetstream::consumer::{pull::Config, AckPolicy};
    let js = async_nats::jetstream::new(client);
    // The core owns the streams; a consumer may come up first (or have no stream-info rights). Create the
    // durable consumer directly (idempotent when the config matches) and wait, bounded, for the stream.
    let cfg = Config {
        durable_name: Some(address.to_string()),
        filter_subject: event_subject(address),
        ack_policy: AckPolicy::Explicit,
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let consumer = loop {
        match js.create_consumer_on_stream(cfg.clone(), EVENTS_STREAM).await {
            Ok(c) => break c,
            Err(e) if started.elapsed() < Duration::from_secs(15) => { tracing::debug!("waiting for stream {EVENTS_STREAM}: {e}"); tokio::time::sleep(Duration::from_millis(250)).await; }
            Err(e) => return Err(format!("consumer {address} on {EVENTS_STREAM}: {e}")),
        }
    };
    let mut messages = consumer.messages().await.map_err(|e| format!("consumer {address} messages: {e}"))?;
    Ok(tokio::spawn(async move {
        while let Some(m) = messages.next().await {
            let Ok(m) = m else { continue };
            match serde_json::from_slice::<Envelope>(&m.payload) {
                Ok(env) => { let _ = handler.handle(&env).await; let _ = m.ack().await; }
                Err(_) => { let _ = m.ack_with(async_nats::jetstream::AckKind::Term).await; }
            }
        }
    }))
}
