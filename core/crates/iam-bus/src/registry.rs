use crate::{BusError, Catalogue, Mode};
use std::sync::RwLock;
use std::collections::HashSet;

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
    fn validate(cat: &Catalogue, s: &Subscription) -> Result<(), BusError> {
        let mode = cat.mode(&s.kind)?;
        if s.subscriber.is_empty() || !s.subscriber.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(BusError::InvalidSubscription("subscriber id must be [A-Za-z0-9_-]+ (it becomes a NATS subject token)".into()));
        }
        if s.mandatory && mode == Mode::Notify { return Err(BusError::InvalidSubscription("mandatory only applies to Control/Query kinds".into())); }
        if s.group.is_some() && mode != Mode::Notify { return Err(BusError::InvalidSubscription("one-of groups only apply to Notify kinds".into())); }
        Ok(())
    }
    pub fn add(&self, cat: &Catalogue, s: Subscription) -> Result<(), BusError> {
        Self::validate(cat, &s)?;
        let mut v = self.0.write().unwrap();
        if v.iter().any(|x| x.subscriber == s.subscriber && x.kind == s.kind) {
            return Err(BusError::InvalidSubscription("already subscribed".into()));
        }
        v.push(s);
        Ok(())
    }
    /// Validate the whole replacement before taking the write lock. Readers see an old or a complete new set.
    pub fn replace(&self, cat: &Catalogue, subscriber: &str, subscriptions: Vec<Subscription>) -> Result<(), BusError> {
        let mut kinds = HashSet::new();
        for s in &subscriptions {
            if s.subscriber != subscriber { return Err(BusError::InvalidSubscription("replacement subscriber mismatch".into())); }
            Self::validate(cat, s)?;
            if !kinds.insert(s.kind.as_str()) { return Err(BusError::InvalidSubscription("duplicate kind in replacement".into())); }
        }
        let mut v = self.0.write().unwrap();
        v.retain(|s| s.subscriber != subscriber);
        v.extend(subscriptions);
        Ok(())
    }
    pub fn remove(&self, subscriber: &str) { self.0.write().unwrap().retain(|s| s.subscriber != subscriber); }
    pub fn matching(&self, kind: &str) -> Vec<Subscription> {
        let mut v: Vec<_> = self.0.read().unwrap().iter().filter(|s| s.kind == kind).cloned().collect();
        v.sort_by(|a, b| a.subscriber.cmp(&b.subscriber)); // stable order: deterministic merge and round robin
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn sub(id: &str, kind: &str) -> Subscription { Subscription { subscriber: id.into(), kind: kind.into(), mandatory: false, group: None } }
    #[test]
    fn invalid_replacement_keeps_existing_routes_and_other_subscribers() {
        let cat = Catalogue::new().declare("one", Mode::Notify).declare("two", Mode::Notify);
        let reg = Registry::new();
        reg.add(&cat, sub("old", "one")).unwrap(); reg.add(&cat, sub("other", "one")).unwrap();
        assert!(reg.replace(&cat, "old", vec![sub("old", "two"), sub("old", "unknown")]).is_err());
        assert!(reg.replace(&cat, "old", vec![sub("old", "two"), sub("old", "two")]).is_err());
        assert!(reg.replace(&cat, "old", vec![sub("other", "two")]).is_err());
        assert_eq!(reg.matching("one").len(), 2); assert_eq!(reg.matching("two").len(), 0);
        reg.replace(&cat, "old", vec![sub("old", "two")]).unwrap();
        assert_eq!(reg.matching("one"), vec![sub("other", "one")]);
        assert_eq!(reg.matching("two"), vec![sub("old", "two")]);
    }
    #[test]
    fn concurrent_replacements_never_remove_the_common_route_from_readers() {
        let cat = Arc::new(Catalogue::new().declare("one", Mode::Notify));
        let reg = Arc::new(Registry::new()); reg.add(&cat, sub("worker", "one")).unwrap();
        let writers: Vec<_> = (0..4).map(|_| { let cat = cat.clone(); let reg = reg.clone(); std::thread::spawn(move || {
            for _ in 0..1000 { reg.replace(&cat, "worker", vec![sub("worker", "one")]).unwrap(); }
        }) }).collect();
        for _ in 0..4000 { assert_eq!(reg.matching("one"), vec![sub("worker", "one")]); }
        for w in writers { w.join().unwrap(); }
    }
}
