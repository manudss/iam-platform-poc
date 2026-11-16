//! Optional sign-in gate: before the IdP checks a password, the core asks the control plane (loopback only) whether the
//! tenant's active auth plugin allows the attempt. FAIL CLOSED: a refusal is a business denial (wrong password, lockout);
//! an unreachable, slow or failing gate is "unavailable" and the sign-in is refused too. The core never signs in without
//! the gate answer when a gate is configured, and never retries a refused attempt on a laxer path.
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Debug, PartialEq)]
pub enum Gate { /// The control plane's untrusted extras (session length): the IdP filters them.
    Allow(Value), Deny, Unavailable }

/// addr must be a loopback host:port (checked at startup by `parse_addr`).
pub fn parse_addr(a: &str) -> Option<String> {
    let sa: std::net::SocketAddr = a.parse().ok()?;
    sa.ip().is_loopback().then(|| a.to_string())
}

pub async fn check(addr: &str, token: &str, tenant: &str, user: &str, password: &str) -> Gate {
    // JSON /authorize path: a single password, no pages. A chain that needs more steps can only be completed in the browser flow, so it is a denial here.
    match step(addr, token, json!({"tenant": tenant, "subject": user, "password": password})).await {
        Step::Allow { claims, .. } => Gate::Allow(claims),
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
    /// An external provider step starts here: the control plane minted the provider URL (state/nonce/PKCE live
    /// server-side in the flow session). The core only redirects to it (docs/sso-federation.md).
    ExternalRedirect(String),
    /// An external provider step in SIMULATED mode: the control plane describes the fictional identities and the
    /// core renders the DEMO chooser page. Never produced when a real client id is configured.
    ExternalSim(Value),
    /// A self-service provider linking finished (member profile): redirect to the recorded return URL when one
    /// was kept, else show a plain confirmation page.
    ExternalLinked(Option<String>),
    Unavailable,
}

/// A provider redirect URL the core may send the browser to: https, or a loopback http URL (local fake provider
/// in dev/e2e). Anything else is treated as a malformed gate answer.
fn provider_url_ok(u: &str) -> bool {
    !u.is_empty() && u.len() <= 2048 && (u.starts_with("https://")
        || u.starts_with("http://localhost") || u.starts_with("http://127.0.0.1") || u.starts_with("http://[::1]"))
}

/// Budget for one gate answer. 3s is comfortable locally; the hosted demo (tiny shared CPU, several bus
/// deliveries per sign-in) needs more, so the image sets IAM_GATE_TIMEOUT_MS higher. Fail-closed semantics are
/// unchanged: a slow gate is still `Unavailable`.
fn gate_timeout() -> Duration {
    std::env::var("IAM_GATE_TIMEOUT_MS").ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&ms| ms >= 250)
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_secs(3))
}

fn parse_step(v: &Value) -> Step {
    match v["outcome"].as_str() {
        Some("allow") => Step::Allow { subject: v["subject"].as_str().map(String::from), claims: v["claims"].clone() },
        Some("challenge") if v["session"].is_string() && v["step"]["fields"].is_array() => Step::Challenge(v.clone()),
        Some("external-redirect") => match v["url"].as_str() { Some(u) if provider_url_ok(u) => Step::ExternalRedirect(u.to_string()), _ => Step::Unavailable },
        Some("external-sim") if v["identities"].is_array() && v["state"].is_string() => Step::ExternalSim(v.clone()),
        Some("external-sim") => Step::Unavailable,
        // A self-service link round-trip finished: the return URL comes from the control plane's server-side
        // record, and is still held to the same https-or-loopback rule before the browser is sent there.
        Some("external-linked") => Step::ExternalLinked(v["returnTo"].as_str().filter(|u| provider_url_ok(u)).map(String::from)),
        _ => Step::Deny(v["message"].as_str().map(String::from)),
    }
}

/// Asks the gate (loopback) for the next step. FAIL CLOSED: anything but a clear 200 answer is `Unavailable`.
pub async fn step(addr: &str, token: &str, body: Value) -> Step {
    match tokio::time::timeout(gate_timeout(), post(addr, token, "/internal/auth/authenticate", &body)).await {
        Ok(Some(v)) => parse_step(&v),
        _ => Step::Unavailable,
    }
}

/// The callback leg of an external-provider round-trip: the step plus `resume`, the authorize params the control
/// plane captured at start (a provider calls back on ONE fixed registered URL, so the request cannot carry them;
/// the params are untrusted here and the core re-validates them before use).
pub async fn external_callback_step(addr: &str, token: &str, body: Value) -> (Step, Option<Value>) {
    match tokio::time::timeout(gate_timeout(), post(addr, token, "/internal/auth/authenticate", &body)).await {
        Ok(Some(v)) => (parse_step(&v), if v["resume"].is_object() { Some(v["resume"].clone()) } else { None }),
        _ => (Step::Unavailable, None),
    }
}

/// First-page description: {"mode":"legacy"}, {"mode":"choice","chains":[...]}, {"mode":"chain","chain":{..},"fields":[...]}
/// or {"mode":"error","message":...} (e.g. an invalid branch-test link). None = gate unavailable.
/// `branch`/`ticket` are the validated branch-test parameters of the authorization request: the control plane checks the ticket
/// before it reveals or uses anything of that branch (see docs/branch-test.md).
pub async fn entry(addr: &str, token: &str, tenant: &str, chain: Option<&str>, branch: Option<&str>, ticket: Option<&str>) -> Option<Value> {
    let mut body = json!({"tenant": tenant});
    if let Some(c) = chain { if !c.is_empty() { body["chain"] = json!(c); } }
    if let Some(b) = branch { if !b.is_empty() { body["branch"] = json!(b); } }
    if let Some(t) = ticket { if !t.is_empty() { body["ticket"] = json!(t); } }
    tokio::time::timeout(gate_timeout(), post(addr, token, "/internal/auth/entry", &body)).await.ok().flatten()
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
