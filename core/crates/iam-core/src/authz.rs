//! Browser authorization-code flow with PKCE (S256) for the IdP PROTOTYPE:
//!   GET  /authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256 -> HTML login form
//!   POST /authorize/login (application/x-www-form-urlencoded, credentials in the BODY only) -> 302 {redirect_uri}?code=..&state=..
//! Rules: client_id and redirect_uri must match the registration exactly BEFORE any form or redirect (invalid -> 400 page, never a redirect);
//! only S256; `state` is required and echoed; a wrong password re-renders the form (401) and never redirects; passwords never appear in URLs.
//! The code is single use and bound to the challenge, redirect_uri and client (see iam-idp). Not a standard OIDC implementation.
use crate::Core;
use axum::{Form, extract::{Query, State}, http::{HeaderValue, StatusCode, header}, response::{IntoResponse, Response}};
use iam_idp::IdpError;
use std::{collections::HashMap, sync::Arc};

fn esc(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;") }
fn pct(s: &str) -> String { s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() }

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

fn form(p: &HashMap<String, String>, error: Option<&str>) -> Response {
    let hid = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"].iter()
        .map(|k| format!("<input type=\"hidden\" name=\"{k}\" value=\"{}\">", esc(p.get(*k).map(String::as_str).unwrap_or("")))).collect::<String>();
    let err = error.map(|e| format!("<p style=\"color:#b00\">{}</p>", esc(e))).unwrap_or_default();
    let ru = p.get("redirect_uri").map(String::as_str).unwrap_or("");
    let origin: String = ru.splitn(4, '/').take(3).collect::<Vec<_>>().join("/"); // scheme://host[:port] of a registered redirect_uri
    page(if error.is_some() { StatusCode::UNAUTHORIZED } else { StatusCode::OK }, format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Sign in (local prototype)</title><h1>Sign in</h1><p>OAuth/OIDC-inspired authentication prototype, local demo accounts only.</p>{err}\
         <form method=\"post\" action=\"/authorize/login\">{hid}<label>User <input name=\"username\" autocomplete=\"username\"></label> \
         <label>Password <input name=\"password\" type=\"password\" autocomplete=\"current-password\"></label> <button type=\"submit\">Sign in</button></form>"), Some(&origin))
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
    match validate(&c, &p) { Err(r) => r, Ok(()) => form(&p, None) }
}

pub async fn login(State(c): State<Arc<Core>>, Form(p): Form<HashMap<String, String>>) -> Response {
    if let Err(r) = validate(&c, &p) { return r; } // hidden fields are not trusted: validated again
    let g = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
    if let Some((addr, tok)) = &c.gate {
        match crate::gate::check(addr, tok, "acme-demo", g("username"), g("password")).await {
            crate::gate::Gate::Allow => {}
            crate::gate::Gate::Deny => return form(&p, Some("Wrong user or password.")),
            crate::gate::Gate::Unavailable => return error_page(StatusCode::SERVICE_UNAVAILABLE, "sign-in is temporarily unavailable"),
        }
    }
    match if c.gate.is_some() { c.idp.authorize_verified(g("client_id"), g("redirect_uri"), g("code_challenge"), g("username")) } else { c.idp.authorize(g("client_id"), g("redirect_uri"), g("code_challenge"), g("username"), g("password")) } {
        Ok(code) => {
            let sep = if g("redirect_uri").contains('?') { '&' } else { '?' };
            let loc = format!("{}{sep}code={}&state={}", g("redirect_uri"), pct(&code), pct(g("state")));
            let mut r = (StatusCode::FOUND, [(header::LOCATION, loc)]).into_response();
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            r
        }
        Err(IdpError::InvalidCredentials) => form(&p, Some("Wrong user or password.")),
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
}
