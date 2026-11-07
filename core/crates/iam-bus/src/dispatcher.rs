use crate::{BusError, Catalogue, Envelope, Mode, Registry, Reply, Subscription, Transport, TransportError, Verdict};
use serde_json::{Map, Value};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SubStatus {
    Replied(Reply),
    /// Notify only (step 3): the event is durably stored in JetStream for this delivery address.
    /// Delivery is at-least-once: the consumer acks after processing, redelivery otherwise.
    Queued,
    /// The subscriber answered "not concerned" (disabled on the envelope's branch): neither an answer nor
    /// silence. Never counts as a refusal, never contributes a verdict or data.
    NotConcerned,
    /// No usable answer in time (timeout, no responder, transport error).
    Silent(String),
    /// An answer arrived but failed the identity/correlation/shape check: treated like silence.
    Invalid(String),
}
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SubOutcome { pub subscriber: String, pub mandatory: bool, pub status: SubStatus }

#[derive(Debug, Clone, PartialEq)]
pub struct CallOutcome { pub verdict: Verdict, pub reason: Option<String>, pub outcomes: Vec<SubOutcome> }

#[derive(Debug, Clone, PartialEq)]
pub struct MergedData {
    pub data: Value,
    /// Keys given by several subscribers with different values: the first subscriber (sorted by id) wins.
    pub conflicts: Vec<String>,
    /// Set when a mandatory subscriber gave no usable answer: the caller must treat the whole query as refused.
    pub refused: Option<String>,
    pub outcomes: Vec<SubOutcome>,
}

/// One exchange seen by the core, handed to observers after the fact (step 1 prepares the later bus-observation milestone).
/// The payload is included only MASKED (see `mask.rs`: credential-like keys replaced, e-mails partly hidden, scalars only, cut at 120 chars).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BusRecord {
    pub envelope_id: String,
    pub kind: String,
    pub mode: Mode,
    pub tenant: Option<String>,
    pub branch: Option<String>,
    pub effect_key: Option<String>,
    /// Who emitted the event (`api`, `plugin:<id>`), absent for core-internal events.
    pub source: Option<String>,
    pub payload_bytes: usize,
    pub payload: std::collections::BTreeMap<String, String>,
    /// Unix milliseconds when the exchange finished.
    pub at_ms: u64,
    pub elapsed_ms: u64,
    pub outcomes: Vec<SubOutcome>,
    /// Control calls only: the merged verdict.
    pub verdict: Option<Verdict>,
}
/// Called synchronously after each notify/call/query; must be fast and must not block (queue the record elsewhere).
pub trait Observer: Send + Sync { fn record(&self, r: &BusRecord); }

pub struct Dispatcher {
    observers: std::sync::RwLock<Vec<Arc<dyn Observer>>>,
    catalogue: Catalogue,
    registry: Registry,
    transport: Arc<dyn Transport>,
    default_timeout: Duration,
}

impl Dispatcher {
    pub fn new(catalogue: Catalogue, transport: Arc<dyn Transport>, default_timeout: Duration) -> Self {
        Dispatcher { observers: Default::default(), catalogue, registry: Registry::new(), transport, default_timeout }
    }
    pub fn subscribe(&self, s: Subscription) -> Result<(), BusError> { self.registry.add(&self.catalogue, s) }
    pub fn catalogue(&self) -> &Catalogue { &self.catalogue }
    /// Observers see every exchange, including refused ones and silent subscribers. Registering one changes no delivery behaviour.
    pub fn observe(&self, o: Arc<dyn Observer>) { self.observers.write().unwrap().push(o) }
    fn emit(&self, env: &Envelope, mode: Mode, t: std::time::Instant, outcomes: &[SubOutcome], verdict: Option<Verdict>) {
        let obs = self.observers.read().unwrap();
        if obs.is_empty() { return }
        let r = BusRecord { envelope_id: env.id.clone(), kind: env.kind.clone(), mode, tenant: env.tenant.clone(), branch: env.branch.clone(), effect_key: env.effect_key.clone(),
            source: env.source.clone(), payload_bytes: env.payload.to_string().len(), payload: crate::mask::mask_payload(&env.payload),
            at_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0), elapsed_ms: t.elapsed().as_millis() as u64, outcomes: outcomes.to_vec(), verdict };
        for o in obs.iter() { o.record(&r) }
    }
    pub fn unsubscribe(&self, subscriber: &str) { self.registry.remove(subscriber) }

    /// One request per subscriber, in parallel, each with its own timeout and its own error: one subscriber failing
    /// never affects another.
    async fn ask(&self, env: &Envelope, subs: Vec<Subscription>, timeout: Duration) -> Vec<SubOutcome> {
        let body = serde_json::to_vec(env).expect("envelope serializes");
        let futs = subs.into_iter().map(|s| {
            let body = body.clone();
            let t = self.transport.clone();
            let id = env.id.clone();
            async move {
                let status = match t.request(&s.subscriber, body, timeout).await {
                    Ok(bytes) => match serde_json::from_slice::<Reply>(&bytes) {
                        Ok(r) if r.from != s.subscriber => SubStatus::Invalid(format!("reply claims to be from '{}'", r.from)),
                        Ok(r) if r.id != id => SubStatus::Invalid("reply does not match the envelope id".into()),
                        Ok(r) if r.not_concerned => SubStatus::NotConcerned,
                        Ok(r) => SubStatus::Replied(r),
                        Err(e) => SubStatus::Invalid(format!("unreadable reply: {e}")),
                    },
                    Err(TransportError::Timeout) => SubStatus::Silent("timeout".into()),
                    Err(TransportError::NoResponder) => SubStatus::Silent("no responder".into()),
                    Err(TransportError::Other(e)) => SubStatus::Silent(e),
                };
                SubOutcome { subscriber: s.subscriber, mandatory: s.mandatory, status }
            }
        });
        futures::future::join_all(futs).await
    }

    /// Notify: broadcast to every subscriber without a group; ONE delivery per group ("one of").
    /// Step 3: delivery is at-least-once through JetStream. The delivery address is the subscriber id, or the
    /// group name for a group (its members share one durable consumer: any one of them processes each event).
    /// A delivery whose publish ack fails counts as a queue failure: every address is still tried, the exchange
    /// is recorded, then the whole notify is REFUSED (BusError::DeliveryFailed) - an emitter never gets a
    /// success without durable storage. A redelivered event can reach a consumer twice: consumers dedupe on
    /// the effect key (idempotent effects).
    pub async fn notify(&self, env: &Envelope) -> Result<Vec<SubOutcome>, BusError> {
        self.catalogue.expect(&env.kind, Mode::Notify)?;
        let all = self.registry.matching(&env.kind);
        let mut targets: Vec<String> = vec![];
        let mut groups: std::collections::HashSet<String> = Default::default();
        for s in all {
            match s.group {
                None => targets.push(s.subscriber),
                Some(g) => { if groups.insert(g.clone()) { targets.push(g); } }
            }
        }
        targets.sort();
        let t = std::time::Instant::now();
        let body = serde_json::to_vec(env).expect("envelope serializes");
        let timeout = self.default_timeout;
        let futs = targets.into_iter().map(|target| {
            let body = body.clone();
            let tr = self.transport.clone();
            async move {
                let status = match tr.queue(&target, body, timeout).await {
                    Ok(()) => SubStatus::Queued,
                    Err(TransportError::Timeout) => SubStatus::Silent("queue failed: timeout".into()),
                    Err(TransportError::NoResponder) => SubStatus::Silent("queue failed: no responder".into()),
                    Err(TransportError::Other(e)) => SubStatus::Silent(format!("queue failed: {e}")),
                };
                SubOutcome { subscriber: target, mandatory: false, status }
            }
        });
        let out = futures::future::join_all(futs).await;
        self.emit(env, Mode::Notify, t, &out, None);
        let failed: Vec<&str> = out.iter().filter(|o| !matches!(o.status, SubStatus::Queued)).map(|o| o.subscriber.as_str()).collect();
        if failed.is_empty() { Ok(out) } else { Err(BusError::DeliveryFailed(format!("not durably queued for: {}", failed.join(", ")))) }
    }

    /// Blocking control with a timeout. Any valid deny = deny. A mandatory subscriber without a usable answer = deny
    /// (fail closed, D3). An optional subscriber without a usable answer is ignored. No subscriber at all = allow.
    pub async fn call(&self, env: &Envelope, timeout: Option<Duration>) -> Result<CallOutcome, BusError> {
        self.catalogue.expect(&env.kind, Mode::Control)?;
        let t0 = std::time::Instant::now();
        let outcomes = self.ask(env, self.registry.matching(&env.kind), timeout.unwrap_or(self.default_timeout)).await;
        let mut reason = None;
        for o in &outcomes {
            match &o.status {
                SubStatus::Replied(r) => match r.verdict {
                    Some(Verdict::Deny) => { reason = Some(format!("denied by '{}'", o.subscriber)); break }
                    Some(Verdict::Allow) => {}
                    None if o.mandatory => { reason = Some(format!("mandatory '{}' gave no verdict", o.subscriber)); break }
                    None => {}
                },
                SubStatus::Silent(why) | SubStatus::Invalid(why) if o.mandatory => { reason = Some(format!("mandatory '{}' unusable: {why}", o.subscriber)); break }
                _ => {}
            }
        }
        let verdict = if reason.is_some() { Verdict::Deny } else { Verdict::Allow };
        self.emit(env, Mode::Control, t0, &outcomes, Some(verdict));
        Ok(CallOutcome { verdict, reason, outcomes })
    }

    /// Query: merges the JSON objects given by subscribers (shallow union). Silent optional subscribers are omitted.
    pub async fn query(&self, env: &Envelope, timeout: Option<Duration>) -> Result<MergedData, BusError> {
        self.catalogue.expect(&env.kind, Mode::Query)?;
        let t0 = std::time::Instant::now();
        let outcomes = self.ask(env, self.registry.matching(&env.kind), timeout.unwrap_or(self.default_timeout)).await;
        let (mut data, mut conflicts, mut refused) = (Map::new(), vec![], None);
        for o in &outcomes {
            match &o.status {
                SubStatus::Replied(r) => {
                    if let Some(Value::Object(m)) = &r.data {
                        for (k, v) in m {
                            match data.get(k) {
                                Some(old) if old != v => { if !conflicts.contains(k) { conflicts.push(k.clone()) } }
                                Some(_) => {}
                                None => { data.insert(k.clone(), v.clone()); }
                            }
                        }
                    } else if o.mandatory { refused.get_or_insert(format!("mandatory '{}' gave no data", o.subscriber)); }
                }
                SubStatus::Silent(why) | SubStatus::Invalid(why) if o.mandatory => { refused.get_or_insert(format!("mandatory '{}' unusable: {why}", o.subscriber)); }
                _ => {}
            }
        }
        self.emit(env, Mode::Query, t0, &outcomes, None);
        Ok(MergedData { data: Value::Object(data), conflicts, refused, outcomes })
    }
}
