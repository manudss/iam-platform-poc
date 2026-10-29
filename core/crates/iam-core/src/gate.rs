//! Optional sign-in gate: before the IdP checks a password, the core asks the control plane (loopback only) whether the
//! tenant's active auth plugin allows the attempt. FAIL CLOSED: a refusal is a business denial (wrong password, lockout);
//! an unreachable, slow or failing gate is "unavailable" and the sign-in is refused too. The core never signs in without
//! the gate answer when a gate is configured, and never retries a refused attempt on a laxer path.
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, PartialEq)]
pub enum Gate { Allow, Deny, Unavailable }

/// addr must be a loopback host:port (checked at startup by `parse_addr`).
pub fn parse_addr(a: &str) -> Option<String> {
    let sa: std::net::SocketAddr = a.parse().ok()?;
    sa.ip().is_loopback().then(|| a.to_string())
}

pub async fn check(addr: &str, token: &str, tenant: &str, user: &str, password: &str) -> Gate {
    // JSON /authorize path: a single password, no pages. A chain that needs more steps can only be completed in the browser flow, so it is a denial here.
    match step(addr, token, json!({"tenant": tenant, "subject": user, "password": password})).await {
        Step::Allow { .. } => Gate::Allow,
        Step::Unavailable => Gate::Unavailable,
        _ => Gate::Deny,
    }
}

/// One answer of the control plane to a sign-in request (see apps/api authn/flow.service.ts).
#[derive(Debug, PartialEq)]
pub enum Step {
    /// `subject` is the identity the control plane verified (None for the legacy single-password answer); `claims` are untrusted extras, filtered by the IdP.
    Allow { subject: Option<String>, claims: Value },
    Deny(Option<String>),
    /// A further step is needed: the JSON of the step (title, message, fields) and the opaque session id.
    Challenge(Value),
    Unavailable,
}

/// Asks the gate (loopback) for the next step. FAIL CLOSED: anything but a clear 200 answer is `Unavailable`.
pub async fn step(addr: &str, token: &str, body: Value) -> Step {
    match tokio::time::timeout(Duration::from_secs(3), post(addr, token, "/internal/auth/authenticate", &body)).await {
        Ok(Some(v)) => match v["outcome"].as_str() {
            Some("allow") => Step::Allow { subject: v["subject"].as_str().map(String::from), claims: v["claims"].clone() },
            Some("challenge") if v["session"].is_string() && v["step"]["fields"].is_array() => Step::Challenge(v),
            _ => Step::Deny(v["message"].as_str().map(String::from)),
        },
        _ => Step::Unavailable,
    }
}

/// First-page description: {"mode":"legacy"} or {"mode":"chain","fields":[...]}. None = gate unavailable.
pub async fn entry(addr: &str, token: &str, tenant: &str) -> Option<Value> {
    tokio::time::timeout(Duration::from_secs(3), post(addr, token, "/internal/auth/entry", &json!({"tenant": tenant}))).await.ok().flatten()
}

async fn post(addr: &str, token: &str, path: &str, body: &Value) -> Option<Value> {
    let body = body.to_string();
    let req = format!("POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nx-gate-token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let mut s = TcpStream::connect(addr).await.ok()?;
    s.write_all(req.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.ok()?;
    let text = String::from_utf8_lossy(&buf);
    let status: u16 = text.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    if status != 200 { return None; }
    serde_json::from_str(text.split("\r\n\r\n").nth(1)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_loopback_gate_addresses_are_accepted() {
        assert!(parse_addr("127.0.0.1:3000").is_some());
        assert!(parse_addr("[::1]:3000").is_some());
        assert!(parse_addr("10.0.0.5:3000").is_none());
        assert!(parse_addr("example.com:80").is_none());
    }
    #[tokio::test]
    async fn an_unreachable_gate_is_unavailable_not_allow() {
        assert_eq!(check("127.0.0.1:1", "tok-12345678", "t", "u", "p").await, Gate::Unavailable);
    }
}
