use crate::{BusError, Catalogue, Mode};
use std::sync::RwLock;

/// `mandatory`: a silent or invalid answer is a refusal (D3), only for Control and Query kinds.
/// `group`: Notify only; one subscriber of the group receives each event ("one of"), the others do not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub subscriber: String,
    pub kind: String,
    pub mandatory: bool,
    pub group: Option<String>,
}

#[derive(Default)]
pub struct Registry(RwLock<Vec<Subscription>>);

impl Registry {
    pub fn new() -> Self { Self::default() }
    pub fn add(&self, cat: &Catalogue, s: Subscription) -> Result<(), BusError> {
        let mode = cat.mode(&s.kind)?;
        if s.subscriber.is_empty() || !s.subscriber.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(BusError::InvalidSubscription("subscriber id must be [A-Za-z0-9_-]+ (it becomes a NATS subject token)".into()));
        }
        if s.mandatory && mode == Mode::Notify { return Err(BusError::InvalidSubscription("mandatory only applies to Control/Query kinds".into())); }
        if s.group.is_some() && mode != Mode::Notify { return Err(BusError::InvalidSubscription("one-of groups only apply to Notify kinds".into())); }
        let mut v = self.0.write().unwrap();
        if v.iter().any(|x| x.subscriber == s.subscriber && x.kind == s.kind) {
            return Err(BusError::InvalidSubscription("already subscribed".into()));
        }
        v.push(s);
        Ok(())
    }
    pub fn remove(&self, subscriber: &str) { self.0.write().unwrap().retain(|s| s.subscriber != subscriber); }
    pub fn matching(&self, kind: &str) -> Vec<Subscription> {
        let mut v: Vec<_> = self.0.read().unwrap().iter().filter(|s| s.kind == kind).cloned().collect();
        v.sort_by(|a, b| a.subscriber.cmp(&b.subscriber)); // stable order: deterministic merge and round robin
        v
    }
}
