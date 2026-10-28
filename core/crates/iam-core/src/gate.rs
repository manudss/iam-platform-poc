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
    match tokio::time::timeout(Duration::from_secs(3), call(addr, token, tenant, user, password)).await {
        Ok(Some(g)) => g,
        _ => Gate::Unavailable,
    }
}

async fn call(addr: &str, token: &str, tenant: &str, user: &str, password: &str) -> Option<Gate> {
    let body = json!({"tenant": tenant, "subject": user, "password": password}).to_string();
    let req = format!("POST /internal/auth/authenticate HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nx-gate-token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let mut s = TcpStream::connect(addr).await.ok()?;
    s.write_all(req.as_bytes()).await.ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.ok()?;
    let text = String::from_utf8_lossy(&buf);
    let status: u16 = text.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    if status != 200 { return None; }
    let v: Value = serde_json::from_str(text.split("\r\n\r\n").nth(1)?).ok()?;
    Some(match v["outcome"].as_str() { Some("allow") => Gate::Allow, _ => Gate::Deny })
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
