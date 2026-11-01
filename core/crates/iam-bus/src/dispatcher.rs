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

pub struct Dispatcher {
    catalogue: Catalogue,
    registry: Registry,
    transport: Arc<dyn Transport>,
    default_timeout: Duration,
    rr: Mutex<HashMap<(String, String), usize>>,
}

impl Dispatcher {
    pub fn new(catalogue: Catalogue, transport: Arc<dyn Transport>, default_timeout: Duration) -> Self {
        Dispatcher { catalogue, registry: Registry::new(), transport, default_timeout, rr: Mutex::new(HashMap::new()) }
    }
    pub fn subscribe(&self, s: Subscription) -> Result<(), BusError> { self.registry.add(&self.catalogue, s) }
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
        Ok(self.ask(env, chosen, self.default_timeout).await)
    }

    /// Blocking control with a timeout. Any valid deny = deny. A mandatory subscriber without a usable answer = deny
    /// (fail closed, D3). An optional subscriber without a usable answer is ignored. No subscriber at all = allow.
    pub async fn call(&self, env: &Envelope, timeout: Option<Duration>) -> Result<CallOutcome, BusError> {
        self.catalogue.expect(&env.kind, Mode::Control)?;
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
        Ok(CallOutcome { verdict: if reason.is_some() { Verdict::Deny } else { Verdict::Allow }, reason, outcomes })
    }

    /// Query: merges the JSON objects given by subscribers (shallow union). Silent optional subscribers are omitted.
    pub async fn query(&self, env: &Envelope, timeout: Option<Duration>) -> Result<MergedData, BusError> {
        self.catalogue.expect(&env.kind, Mode::Query)?;
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
        Ok(MergedData { data: Value::Object(data), conflicts, refused, outcomes })
    }
}
