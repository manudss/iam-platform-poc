//! Masking of what an observer may see. Same rules as the API journal (apps/api/src/journal/journal.ts):
//! credential-like keys are replaced, e-mail addresses are partly hidden, only scalars survive, long values are cut.
use serde_json::Value;
use std::collections::BTreeMap;

const DENY: &[&str] = &["token", "password", "passwd", "secret", "credential", "code", "pin", "authorization", "cookie", "key", "hash", "salt", "otp", "signature"];
/// Keys shown as they are: identifiers and counters, never credentials (checked before DENY: `effectKey` contains "key").
const KEEP: &[&str] = &["subject", "effectKey", "actor", "from", "to", "organization", "decision", "field", "keys", "role", "department", "plugin", "hook", "type", "tenant", "seq", "commit", "outcome"];

pub fn mask_email(v: &str) -> String {
    // x@y.tld -> x***@y***.tld, scanning words so it also works inside free text
    v.split(' ').map(|w| match w.split_once('@') {
        Some((l, r)) if !l.is_empty() && !r.is_empty() && r.contains('.') => {
            let (host, tld) = r.rsplit_once('.').unwrap();
            format!("{}***@{}***.{}", l.chars().next().unwrap(), host.chars().next().unwrap_or('*'), tld)
        }
        _ => w.to_string(),
    }).collect::<Vec<_>>().join(" ")
}

fn cut(s: String) -> String { s.chars().take(120).collect() }

pub fn mask_payload(p: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Value::Object(m) = p else { return out };
    for (k, v) in m {
        let lk = k.to_lowercase();
        if !KEEP.iter().any(|x| x.to_lowercase() == lk) && DENY.iter().any(|d| lk.contains(d)) { out.insert(k.clone(), "[masked]".into()); continue }
        match v {
            Value::Null => {}
            Value::Object(_) => { out.insert(k.clone(), "[object]".into()); }
            Value::Array(a) if a.iter().all(|x| x.is_string()) => { out.insert(k.clone(), cut(mask_email(&a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(",")))); }
            Value::Array(_) => { out.insert(k.clone(), "[object]".into()); }
            Value::String(s) => { out.insert(k.clone(), cut(mask_email(s))); }
            other => { out.insert(k.clone(), cut(other.to_string())); }
        }
    }
    out
}
