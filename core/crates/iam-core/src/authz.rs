//! Browser authorization-code flow with PKCE (S256) for the IdP PROTOTYPE:
//!   GET  /authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256 -> HTML login form
//!   POST /authorize/login (application/x-www-form-urlencoded, credentials in the BODY only) -> 302 {redirect_uri}?code=..&state=..
//! Rules: client_id and redirect_uri must match the registration exactly BEFORE any form or redirect (invalid -> 400 page, never a redirect);
//! only S256; `state` is required and echoed; a wrong password re-renders the form (401) and never redirects; passwords never appear in URLs.
//! The code is single use and bound to the challenge, redirect_uri and client (see iam-idp). Not a standard OIDC implementation.
use crate::Core;
use axum::{Form, extract::{Query, State}, http::{HeaderValue, StatusCode, header}, response::{IntoResponse, Response}};
use iam_idp::IdpError;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;") }
fn pct(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

const STYLE: &str = "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f5f9;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a}main{width:min(26rem,calc(100vw - 2rem));background:#fff;border:1px solid #e2e8f0;border-radius:.9rem;padding:1.4rem 1.5rem;box-shadow:0 8px 28px #4f46e51f}h1{font-size:1.35rem;margin:0 0 .4rem}p{margin:.4rem 0;color:#475569}label{display:block;margin:.8rem 0 0;font-weight:600}input{display:block;width:100%;margin-top:.25rem;padding:.65rem .75rem;font:inherit;border:1px solid #cbd5e1;border-radius:.55rem}input:focus{outline:2px solid #6366f1;border-color:#6366f1}button{margin-top:1.1rem;width:100%;padding:.7rem;font:inherit;font-weight:600;color:#fff;background:#4f46e5;border:0;border-radius:.55rem;cursor:pointer}.demo{background:#fffbeb;border:1px solid #fcd34d;border-radius:.55rem;padding:.5rem .7rem;color:#92400e}</style>";
fn page(status: StatusCode, body: String, form_target: Option<&str>) -> Response {
    let mut r = (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response();
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    // Browsers also apply form-action to the redirect that follows the POST: the (already validated, registered) redirect origin must be allowed.
    let csp = format!("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'{}", form_target.map(|o| format!(" {o}")).unwrap_or_default());
    if let Ok(v) = HeaderValue::from_str(&csp) { h.insert(header::CONTENT_SECURITY_POLICY, v); }
    r
}
fn error_page(status: StatusCode, msg: &str) -> Response { page(status, format!("<!doctype html><title>Sign-in error</title><p>{}</p>", esc(msg)), None) }

fn hidden(p: &HashMap<String, String>) -> String {
    ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"].iter()
        .map(|k| format!("<input type=\"hidden\" name=\"{k}\" value=\"{}\">", esc(p.get(*k).map(String::as_str).unwrap_or("")))).collect::<String>()
}
fn origin_of(p: &HashMap<String, String>) -> String {
    let ru = p.get("redirect_uri").map(String::as_str).unwrap_or("");
    ru.splitn(4, '/').take(3).collect::<Vec<_>>().join("/") // scheme://host[:port] of a registered redirect_uri
}
/// One input of a step, from the control plane's description. Names are restricted to [a-z0-9]{1,12} and types to a fixed list: the description is not trusted as markup.
fn input_html(f: &Value) -> Option<String> {
    let name = f["name"].as_str().filter(|n| !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))?;
    let label = f["label"].as_str().unwrap_or(name);
    let max = f["maxLength"].as_u64().filter(|m| (1..=64).contains(m)).map(|m| format!(" maxlength=\"{m}\"")).unwrap_or_default();
    let hint = f["hint"].as_str().map(|h| format!(" placeholder=\"{}\"", esc(h))).unwrap_or_default();
    // A step named "password" keeps the classic field name so the classic form and scripts keep working; every other input is a_<name>.
    let attr = if name == "password" { "password".to_string() } else { format!("a_{name}") };
    let kind = match f["type"].as_str() { Some("password") => "type=\"password\" autocomplete=\"off\"", Some("digits") => "type=\"text\" inputmode=\"numeric\" autocomplete=\"one-time-code\"", _ => "type=\"text\" autocomplete=\"off\"" };
    let kind = if name == "password" { "type=\"password\" autocomplete=\"current-password\"" } else { kind };
    Some(format!("<label>{} <input name=\"{attr}\" {kind}{max}{hint}></label> ", esc(label)))
}

/// First page. `fields` None = the classic user + password form (no chain is live). Some(fields) = user name plus the first step's inputs (possibly none).
fn form(p: &HashMap<String, String>, error: Option<&str>, fields: Option<&[Value]>) -> Response {
    let hid = hidden(p);
    let err = error.map(|e| format!("<p style=\"color:#b91c1c\">{}</p>", esc(e))).unwrap_or_default();
    let inputs = match fields {
        None => "<label>Password <input name=\"password\" type=\"password\" autocomplete=\"current-password\"></label> ".to_string(),
        Some(f) => f.iter().filter_map(input_html).collect::<String>(),
    };
    let button = if fields.is_some_and(|f| f.is_empty()) { "Continue" } else { "Sign in" };
    page(if error.is_some() { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, format!(
        "<!doctype html><meta charset=\"utf-8\">{STYLE}<title>Sign in (local prototype)</title><main><h1>Sign in</h1><p>OAuth/OIDC-inspired authentication prototype, local demo accounts only.</p>{err}\
         <form method=\"post\" action=\"/authorize/login\">{hid}<label>User <input name=\"username\" autocomplete=\"username\"></label> {inputs}<button type=\"submit\">{button}</button></form></main>"), Some(&origin_of(p)))
}

/// A later step of a chain: the opaque session id is the only link to the first page (the user name is not sent again).
fn step_page(p: &HashMap<String, String>, v: &Value, error: Option<&str>) -> Response {
    let st = &v["step"];
    let title = st["title"].as_str().unwrap_or("Verification");
    let (i, n) = (st["index"].as_u64().unwrap_or(0) + 1, st["total"].as_u64().unwrap_or(1));
    let msg = st["message"].as_str().map(|m| format!("<p{}>{}</p>", if m.starts_with("DEMO") { " class=\"demo\"" } else { "" }, esc(m))).unwrap_or_default();
    let err = error.or(v["error"].as_str()).map(|e| format!("<p style=\"color:#b91c1c\" role=\"alert\">{}</p>", esc(e))).unwrap_or_default();
    let inputs = st["fields"].as_array().map(|f| f.iter().filter_map(input_html).collect::<String>()).unwrap_or_default();
    page(if error.is_some() || v["error"].is_string() { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, format!(
        "<!doctype html><meta charset=\"utf-8\">{STYLE}<title>Sign in, step {i} of {n}</title><main><h1>{}</h1><p>Step {i} of {n}.</p>{msg}{err}\
         <form method=\"post\" action=\"/authorize/login\">{}<input type=\"hidden\" name=\"session\" value=\"{}\">{inputs}<button type=\"submit\">Continue</button></form></main>",
        esc(title), hidden(p), esc(v["session"].as_str().unwrap_or(""))), Some(&origin_of(p)))
}

/// Validates the authorization request parameters. Err = (status, message), never a redirect.
fn validate(c: &Core, p: &HashMap<String, String>) -> Result<(), Response> {
    let g = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    if !c.idp.check_client(g("client_id"), g("redirect_uri")) { return Err(error_page(StatusCode::BAD_REQUEST, "unknown client or redirect_uri")); }
    if p.get("response_type").map(String::as_str).unwrap_or("code") != "code" { return Err(error_page(StatusCode::BAD_REQUEST, "only response_type=code")); }
    if g("code_challenge_method") != "S256" { return Err(error_page(StatusCode::BAD_REQUEST, "code_challenge_method must be S256")); }
    if g("code_challenge").len() < 43 || g("code_challenge").len() > 128 { return Err(error_page(StatusCode::BAD_REQUEST, "invalid code_challenge")); }
    if g("state").is_empty() || g("state").len() > 256 { return Err(error_page(StatusCode::BAD_REQUEST, "state is required (max 256 chars)")); }
    Ok(())
}

pub async fn authorize_form(State(c): State<Arc<Core>>, Query(p): Query<HashMap<String, String>>) -> Response {
    if let Err(r) = validate(&c, &p) { return r; }
    let Some((addr, tok)) = &c.gate else { return form(&p, None, None) };
    match crate::gate::entry(addr, tok, "acme-demo").await {
        None => error_page(StatusCode::SERVICE_UNAVAILABLE, "sign-in is temporarily unavailable"),
        Some(v) if v["mode"] == "chain" => form(&p, None, Some(v["fields"].as_array().map(Vec::as_slice).unwrap_or(&[]))),
        Some(_) => form(&p, None, None),
    }
}

pub async fn login(State(c): State<Arc<Core>>, Form(p): Form<HashMap<String, String>>) -> Response {
    if let Err(r) = validate(&c, &p) { return r; } // hidden fields are not trusted: validated again
    let g = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    let mut extra = Value::Null;
    let mut who = g("username").to_string();
    if let Some((addr, tok)) = &c.gate {
        // Everything the user typed for the step travels as `answers`; the control plane decides what it means. A bare `password` is the classic form.
        let mut answers = serde_json::Map::new();
        for (k, v) in &p { if let Some(n) = k.strip_prefix("a_").filter(|n| !n.is_empty() && n.len() <= 12 && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())) { answers.insert(n.to_string(), json!(v)); } }
        let session = g("session");
        let mut body = json!({"tenant": "acme-demo"});
        if !session.is_empty() { body["session"] = json!(session); } else { body["subject"] = json!(g("username")); if !g("password").is_empty() { body["password"] = json!(g("password")); } }
        if !answers.is_empty() { body["answers"] = Value::Object(answers); }
        // A step page has no first-page inputs: after a failed first page, show the first page again.
        let first_page = || async { match crate::gate::entry(addr, tok, "acme-demo").await { Some(v) if v["mode"] == "chain" => Some(v["fields"].as_array().cloned().unwrap_or_default()), _ => None } };
        match crate::gate::step(addr, tok, body).await {
            crate::gate::Step::Allow { subject, claims } => {
                if !session.is_empty() { match subject { Some(s) => who = s, None => return form(&p, Some("Sign-in failed. Check your details and try again."), None) } } else if let Some(s) = subject { who = s; }
                extra = claims;
            }
            crate::gate::Step::Deny(m) => {
                let msg = m.unwrap_or_else(|| "Wrong user or password.".into());
                return match first_page().await { Some(f) => form(&p, Some(&msg), Some(&f)), None => form(&p, Some(&msg), None) };
            }
            crate::gate::Step::Challenge(v) => return step_page(&p, &v, None),
            crate::gate::Step::Unavailable => return error_page(StatusCode::SERVICE_UNAVAILABLE, "sign-in is temporarily unavailable"),
        }
    }
    match if c.gate.is_some() { c.idp.authorize_verified_with(g("client_id"), g("redirect_uri"), g("code_challenge"), &who, &extra) } else { c.idp.authorize(g("client_id"), g("redirect_uri"), g("code_challenge"), g("username"), g("password")) } {
        Ok(code) => {
            let sep = if g("redirect_uri").contains('?') { '&' } else { '?' };
            let loc = format!("{}{sep}code={}&state={}", g("redirect_uri"), pct(&code), pct(g("state")));
            let mut r = (StatusCode::FOUND, [(header::LOCATION, loc)]).into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }
        Err(IdpError::InvalidCredentials) => form(&p, Some("Wrong user or password."), None),
        Err(_) => error_page(StatusCode::BAD_REQUEST, "invalid request"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use iam_decision::Engine;
    use iam_idp::Idp;
    use tower::ServiceExt;

    const CH: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // S256 of the RFC 7636 example verifier
    const VER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const CB: &str = "http://localhost:4200/callback";

    fn core() -> Arc<Core> { Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test"))) }
    async fn send(c: &Arc<Core>, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
        let r = app(c.clone()).oneshot(req).await.unwrap();
        let (st, h) = (r.status(), r.headers().clone());
        (st, h, String::from_utf8_lossy(&r.into_body().collect().await.unwrap().to_bytes()).into_owned())
    }
    fn get(q: &str) -> Request<Body> { Request::builder().uri(format!("/authorize?{q}")).body(Body::empty()).unwrap() }
    fn post_login(body: &str) -> Request<Body> {
        Request::builder().method("POST").uri("/authorize/login").header("content-type", "application/x-www-form-urlencoded").body(Body::from(body.to_string())).unwrap()
    }
    fn q(extra: &str) -> String { format!("response_type=code&client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256{extra}") }
    fn login_body(user: &str, pw: &str) -> String { format!("client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256&username={user}&password={pw}") }

    #[tokio::test]
    async fn full_browser_flow_form_login_redirect_token() {
        let c = core();
        let (st, h, body) = send(&c, get(&q(""))).await;
        assert_eq!(st, StatusCode::OK);
        assert!(body.contains("type=\"password\"") && body.contains("action=\"/authorize/login\"") && body.contains("name=\"state\" value=\"st ate\""));
        assert_eq!(h["x-frame-options"], "DENY"); assert!(h[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("form-action 'self' http://localhost:4200"));
        let (st, h, _) = send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret"))).await;
        assert_eq!(st, StatusCode::FOUND);
        let loc = h[header::LOCATION].to_str().unwrap().to_string();
        assert!(loc.starts_with(&format!("{CB}?code=")) && loc.ends_with("&state=st%20ate"), "{loc}");
        assert!(!loc.contains("demo-only-not-a-secret") && !loc.contains("password"));
        let code = loc.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let tok = |code: &str, v: &str| Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{v}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        let (st, _, body) = send(&c, tok(code, VER)).await;
        assert_eq!(st, StatusCode::OK); assert!(body.contains("id_token"));
        assert_eq!(send(&c, tok(code, VER)).await.0, StatusCode::BAD_REQUEST); // single use
    }

    #[tokio::test]
    async fn negatives_never_redirect_and_never_leak() {
        let c = core();
        // unregistered redirect_uri / client: 400 page, no Location
        let (st, h, _) = send(&c, get(&q("").replace("localhost%3A4200", "evil.example"))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST); assert!(h.get(header::LOCATION).is_none());
        let (st, h, _) = send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret").replace("localhost%3A4200", "evil.example"))).await;
        assert_eq!(st, StatusCode::BAD_REQUEST); assert!(h.get(header::LOCATION).is_none());
        // prefix / suffix tricks are not exact matches
        for ru in ["http%3A%2F%2Flocalhost%3A4200%2Fcallback%2Fx", "http%3A%2F%2Flocalhost%3A4200%2Fcallback%3Fa%3D1", "http%3A%2F%2Flocalhost%3A4200"] {
            let b = login_body("demo-alice", "demo-only-not-a-secret").replace("http%3A%2F%2Flocalhost%3A4200%2Fcallback", ru);
            assert_eq!(send(&c, post_login(&b)).await.0, StatusCode::BAD_REQUEST, "{ru}");
        }
        // plain PKCE, missing method, missing state, short challenge, wrong response_type
        assert_eq!(send(&c, get(&q("").replace("S256", "plain"))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("&code_challenge_method=S256", ""))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("&state=st%20ate", ""))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace(CH, "short"))).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(send(&c, get(&q("").replace("response_type=code", "response_type=token"))).await.0, StatusCode::BAD_REQUEST);
        // wrong password / unknown user: 401 form again, no redirect, password not echoed
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "wrong-pass-123"))).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none());
        assert!(body.contains("Wrong user or password") && !body.contains("wrong-pass-123"));
        assert_eq!(send(&c, post_login(&login_body("nobody", "x"))).await.0, StatusCode::UNAUTHORIZED);
        // HTML injection through parameters is escaped in the form
        let (_, _, body) = send(&c, get(&q("").replace("st%20ate", "%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E"))).await;
        assert!(!body.contains("<script>") && body.contains("&lt;script&gt;"));
        // wrong verifier burns the code
        let (_, h, _) = send(&c, post_login(&login_body("demo-bob", "demo-only-not-a-secret"))).await;
        let code = h[header::LOCATION].to_str().unwrap().split("code=").nth(1).unwrap().split('&').next().unwrap().to_string();
        let bad = Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}", "x".repeat(50)))).unwrap();
        assert_eq!(send(&c, bad).await.0, StatusCode::BAD_REQUEST);
        let good = Request::builder().method("POST").uri("/token").header("content-type", "application/json")
            .body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{VER}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        assert_eq!(send(&c, good).await.0, StatusCode::BAD_REQUEST);
    }

    // ---- multi-step sign-in through a fake control-plane gate ----
    async fn fake_gate() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let addr = l.local_addr().unwrap().to_string();
        tokio::spawn(async move { loop {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = Vec::new(); let mut tmp = [0u8; 4096];
            loop { let n = s.read(&mut tmp).await.unwrap(); buf.extend_from_slice(&tmp[..n]); let t = String::from_utf8_lossy(&buf).to_string();
                if let Some(h) = t.find("\r\n\r\n") { let cl = t[..h].lines().find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0); if buf.len() >= h + 4 + cl { break; } } if n == 0 { break; } }
            let t = String::from_utf8_lossy(&buf).to_string(); let path = t.split_whitespace().nth(1).unwrap().to_string();
            let body: Value = serde_json::from_str(t.split("\r\n\r\n").nth(1).unwrap()).unwrap();
            let out = if path.ends_with("/entry") { json!({"mode":"chain","fields":[{"name":"password","label":"Password","type":"password"}]}) }
            else if body["session"] == "sess1" {
                if body["answers"]["code"] == "123456" { json!({"outcome":"allow","subject":"demo-alice","chain":"mfa","claims":{"amr":["pwd","otp"],"auth_level":8,"auth_level_declared":9,"auth_mfa":true,"auth_level_basis":"configured","iss":"evil","sub":"evil","exp":1,"role":"admin"}}) }
                else { json!({"outcome":"challenge","session":"sess1","error":"Incorrect answer. 2 attempt(s) left.","step":{"index":1,"total":2,"title":"Authenticator code","fields":[{"name":"code","label":"Code","type":"digits","maxLength":6}]}}) }
            } else if body["password"] == "pw" && body["subject"] == "demo-alice" { json!({"outcome":"challenge","session":"sess1","step":{"index":1,"total":2,"title":"Authenticator <code>","message":"Open your app","fields":[{"name":"code","label":"Code","type":"digits","maxLength":6},{"name":"bad name","label":"x","type":"text"}]}}) }
            else { json!({"outcome":"deny","reason":"bad-credentials","message":"Sign-in failed. Check your details and try again."}) };
            let o = out.to_string(); s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{o}", o.len()).as_bytes()).await.unwrap();
        } });
        addr
    }
    #[tokio::test]
    async fn two_step_sign_in_filters_claims_and_never_trusts_the_form_user_after_the_first_step() {
        let addr = fake_gate().await;
        let mut core = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); core.gate = Some((addr, "tok-12345678".into()));
        let c = Arc::new(core);
        let (st, _, body) = send(&c, get(&q(""))).await; assert_eq!(st, StatusCode::OK); assert!(body.contains("name=\"password\"") && body.contains("name=\"username\""));
        // first step wrong: back to the first page with the generic message, 401, no redirect
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "bad"))).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none() && body.contains("Sign-in failed") && body.contains("name=\"password\""));
        // first step right: a second page, escaped, only valid inputs, the session is the only link
        let (st, h, body) = send(&c, post_login(&login_body("demo-alice", "pw"))).await; assert_eq!(st, StatusCode::OK); assert!(h.get(header::LOCATION).is_none());
        assert!(body.contains("Step 2 of 2") && body.contains("Authenticator &lt;code&gt;") && body.contains("name=\"a_code\"") && body.contains("name=\"session\" value=\"sess1\""));
        assert!(!body.contains("bad name") && !body.contains("name=\"username\"") && !body.contains("<code>"));
        let step = |code: &str, who: &str| post_login(&format!("client_id=demo-web&redirect_uri=http%3A%2F%2Flocalhost%3A4200%2Fcallback&state=st%20ate&code_challenge={CH}&code_challenge_method=S256&session=sess1&username={who}&a_code={code}"));
        let (st, h, body) = send(&c, step("000000", "demo-alice")).await; assert_eq!(st, StatusCode::UNAUTHORIZED); assert!(h.get(header::LOCATION).is_none() && body.contains("2 attempt(s) left") && body.contains("Step 2 of 2"));
        // right code, but the form claims another user: the identity is the one the control plane verified
        let (st, h, _) = send(&c, step("123456", "demo-bob")).await; assert_eq!(st, StatusCode::FOUND);
        let loc = h[header::LOCATION].to_str().unwrap().to_string(); let code = loc.split("code=").nth(1).unwrap().split('&').next().unwrap();
        let tok = Request::builder().method("POST").uri("/token").header("content-type", "application/json").body(Body::from(format!("{{\"code\":\"{code}\",\"code_verifier\":\"{VER}\",\"redirect_uri\":\"{CB}\",\"client_id\":\"demo-web\"}}"))).unwrap();
        let (st, _, body) = send(&c, tok).await; assert_eq!(st, StatusCode::OK);
        let idt = serde_json::from_str::<Value>(&body).unwrap()["id_token"].as_str().unwrap().to_string();
        let claims = iam_idp::verify(&idt, &c.idp.jwks(), "http://idp.test").unwrap();
        assert_eq!(claims["sub"], "demo-alice"); assert_eq!(claims["auth_level"], 8); assert_eq!(claims["auth_level_declared"], 9); assert_eq!(claims["auth_mfa"], true); assert_eq!(claims["amr"], json!(["pwd", "otp"]));
        assert_eq!(claims["auth_level_basis"], "configured"); assert_eq!(claims["iss"], "http://idp.test"); assert!(claims.get("role").is_none());
    }
    #[tokio::test]
    async fn an_unreachable_gate_refuses_the_form_and_the_login() {
        let mut core = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); core.gate = Some(("127.0.0.1:1".into(), "tok-12345678".into()));
        let c = Arc::new(core);
        assert_eq!(send(&c, get(&q(""))).await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(send(&c, post_login(&login_body("demo-alice", "demo-only-not-a-secret"))).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }
}
