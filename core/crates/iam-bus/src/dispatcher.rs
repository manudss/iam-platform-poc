use crate::{BusError, Catalogue, Envelope, Mode, Registry, Reply, Subscription, Transport, TransportError, Verdict};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum SubStatus {
    Replied(Reply),
    /// No usable answer in time (timeout, no responder, transport error).
    Silent(String),
    /// An answer arrived but failed the identity/correlation/shape check: treated like silence.
    Invalid(String),
}
#[derive(Debug, Clone, PartialEq)]
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
#[derive(Debug, Clone, PartialEq)]
pub struct BusRecord {
    pub envelope_id: String,
    pub kind: String,
    pub mode: Mode,
    pub tenant: Option<String>,
    pub effect_key: Option<String>,
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
    rr: Mutex<HashMap<(String, String), usize>>,
}

impl Dispatcher {
    pub fn new(catalogue: Catalogue, transport: Arc<dyn Transport>, default_timeout: Duration) -> Self {
        Dispatcher { observers: Default::default(), catalogue, registry: Registry::new(), transport, default_timeout, rr: Mutex::new(HashMap::new()) }
    }
    pub fn subscribe(&self, s: Subscription) -> Result<(), BusError> { self.registry.add(&self.catalogue, s) }
    /// Observers see every exchange, including refused ones and silent subscribers. Registering one changes no delivery behaviour.
    pub fn observe(&self, o: Arc<dyn Observer>) { self.observers.write().unwrap().push(o) }
    fn emit(&self, env: &Envelope, mode: Mode, t: std::time::Instant, outcomes: &[SubOutcome], verdict: Option<Verdict>) {
        let obs = self.observers.read().unwrap();
        if obs.is_empty() { return }
        let r = BusRecord { envelope_id: env.id.clone(), kind: env.kind.clone(), mode, tenant: env.tenant.clone(), effect_key: env.effect_key.clone(),
            payload_bytes: env.payload.to_string().len(), payload: crate::mask::mask_payload(&env.payload),
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

    /// Notify: broadcast to every subscriber without a group; one subscriber (round robin) per group.
    /// At-most-once, errors are reported per subscriber and never raised.
    pub async fn notify(&self, env: &Envelope) -> Result<Vec<SubOutcome>, BusError> {
        self.catalogue.expect(&env.kind, Mode::Notify)?;
        let all = self.registry.matching(&env.kind);
        let mut chosen = vec![];
        let mut groups: HashMap<String, Vec<Subscription>> = HashMap::new();
        for s in all { match s.group.clone() { None => chosen.push(s), Some(g) => groups.entry(g).or_default().push(s) } }
        let mut names: Vec<_> = groups.keys().cloned().collect();
        names.sort();
        for g in names {
            let members = &groups[&g];
            let mut rr = self.rr.lock().unwrap();
            let n = rr.entry((env.kind.clone(), g)).or_insert(0);
            chosen.push(members[*n % members.len()].clone());
            *n += 1;
        }
        let t = std::time::Instant::now();
        let out = self.ask(env, chosen, self.default_timeout).await;
        self.emit(env, Mode::Notify, t, &out, None);
        Ok(out)
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
