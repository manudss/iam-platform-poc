//! POC identity provider module: OIDC authorization-code + PKCE (S256), Ed25519 (EdDSA) id tokens, JWKS.
//! OAuth/OIDC-inspired authentication PROTOTYPE: JSON endpoints plus a browser authorization-code flow (GET /authorize form, 302 with code and state,
//! see iam-core `authz.rs`). Not a standard OIDC implementation (no userinfo, refresh, consent, MFA, sessions).
//! NOT production: in-memory keys and codes, fictional demo users, no sessions, MFA, passkeys, SAML,
//! consent, refresh tokens, rate limiting or key rotation. See README "Not built yet".
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey, Signature};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

#[derive(Debug, PartialEq, Eq)]
pub enum IdpError { InvalidClient, InvalidCredentials, InvalidGrant, InvalidRequest(&'static str) }

struct Code { user: String, challenge: String, redirect_uri: String, client_id: String, exp: u64, extra: serde_json::Map<String, Value>, branch: Option<String> }

pub struct Idp {
    key: SigningKey,
    issuer: String,
    client_id: String,
    redirect_uris: Vec<String>,
    users: HashMap<String, String>, // username -> demo password (FICTIONAL, plain text on purpose: demo only)
    codes: Mutex<HashMap<String, Code>>,
    ttl: u64,
    /// Hard ceiling on every token lifetime, set only from the operator's environment (IAM_TOKEN_TTL_SECS).
    ttl_cap: Option<u64>,
}

/// Authentication facts a sign-in may add to the id_token. Strict whitelist and shapes: the control plane's answer is not trusted to set anything else.
/// `auth_level` is a level CONFIGURED by an administrator (1..10, 10 = strongest), not a measured assurance; `auth_mfa` is true only when two different
/// factor categories were verified for real; `auth_simulated` lists steps that were simulated and therefore not counted.
pub fn safe_auth_claims(extra: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(o) = extra.as_object() else { return out };
    let strs = |v: &Value| v.as_array().filter(|a| a.len() <= 8).filter(|a| a.iter().all(|x| x.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')))).is_some();
    for (k, v) in o {
        let ok = match k.as_str() {
            "amr" | "auth_methods" | "auth_simulated" => strs(v),
            "auth_level" | "auth_level_declared" => v.as_u64().is_some_and(|n| (1..=10).contains(&n)),
            "auth_mfa" => v.is_boolean(),
            // Session settings (docs/session.md): seconds, bounded so the control plane can never ask for an unbounded token.
            "session_ttl" => v.as_u64().is_some_and(|n| (10..=604_800).contains(&n)),
            "session_warn" => v.as_u64().is_some_and(|n| (1..=86_400).contains(&n)),
            "session_max" => v.as_u64().is_some_and(|n| (10..=604_800).contains(&n)),
            "auth_level_basis" | "auth_chain" => v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 40 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')),
            _ => false,
        };
        if ok { out.insert(k.clone(), v.clone()); }
    }
    out
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() }
fn rand_token() -> String { let b: [u8; 24] = rand::random(); B64.encode(b) }

/// Registered redirect URIs of the demo client: the local console, plus any comma-separated
/// extras in IAM_IDP_EXTRA_REDIRECT_URIS (e.g. a hosted demo origin). Exact-match checked before
/// any form or redirect, so an unlisted URI is always refused.
fn demo_redirect_uris() -> Vec<String> {
    let mut v = vec!["http://localhost:4200/callback".to_string()];
    if let Ok(extra) = std::env::var("IAM_IDP_EXTRA_REDIRECT_URIS") {
        v.extend(extra.split(',').map(str::trim).filter(|u| !u.is_empty()).map(str::to_string));
    }
    v
}

impl Idp {
    pub fn demo(issuer: &str) -> Self {
        let seed: [u8; 32] = rand::random();
        let mut users = HashMap::new();
        users.insert("demo-alice".to_string(), "demo-only-not-a-secret".to_string());
        users.insert("demo-bob".to_string(), "demo-only-not-a-secret".to_string());
        Self {
            key: SigningKey::from_bytes(&seed), issuer: issuer.into(), client_id: "demo-web".into(),
            redirect_uris: demo_redirect_uris(), users, codes: Mutex::new(HashMap::new()), ttl: 300, ttl_cap: None,
        }
    }

    /// Token lifetime in seconds (local testing only, e.g. 1 to test expiry).
    pub fn with_ttl(mut self, ttl: u64) -> Self { self.ttl = ttl; self }
    /// Operator ceiling: no token lives longer than this, whatever the configured session length says.
    pub fn with_ttl_cap(mut self, cap: u64) -> Self { self.ttl_cap = Some(cap); self }
    pub fn issuer(&self) -> &str { &self.issuer }

    /// Session length of a token: the configured `session_ttl` (set by the control plane at sign-in), else the default, never above the operator ceiling.
    fn session_ttl(&self, claims: &serde_json::Map<String, Value>) -> u64 {
        let t = claims.get("session_ttl").and_then(Value::as_u64).unwrap_or(self.ttl);
        self.ttl_cap.map_or(t, |c| t.min(c))
    }

    pub fn discovery(&self) -> Value {
        json!({"issuer": self.issuer, "authorization_endpoint": format!("{}/authorize", self.issuer),
          "token_endpoint": format!("{}/token", self.issuer), "jwks_uri": format!("{}/jwks.json", self.issuer),
          "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"],
          "code_challenge_methods_supported": ["S256"], "id_token_signing_alg_values_supported": ["EdDSA"],
          "subject_types_supported": ["public"]})
    }

    pub fn jwks(&self) -> Value {
        let x = B64.encode(self.key.verifying_key().to_bytes());
        json!({"keys": [{"kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","kid":"poc-1","x": x}]})
    }

    /// True when client_id and redirect_uri exactly match the registered client (checked BEFORE showing a form or redirecting anywhere).
    pub fn check_client(&self, client_id: &str, redirect_uri: &str) -> bool {
        client_id == self.client_id && self.redirect_uris.iter().any(|u| u == redirect_uri)
    }

    /// Simplified login step: checks the user and issues a single-use code bound to the PKCE challenge.
    pub fn authorize(&self, client_id: &str, redirect_uri: &str, code_challenge: &str, username: &str, password: &str)
        -> Result<String, IdpError> {
        if self.users.get(username).map(|p| p == password) != Some(true) { return Err(IdpError::InvalidCredentials); }
        self.authorize_verified(client_id, redirect_uri, code_challenge, username)
    }

    /// Called ONLY after the configured loopback gate verified this user's credentials. No password bypass in HTTP routes.
    pub fn authorize_verified(&self, client_id: &str, redirect_uri: &str, code_challenge: &str, username: &str) -> Result<String, IdpError> {
        self.authorize_verified_with(client_id, redirect_uri, code_challenge, username, &Value::Null)
    }

    /// Like `authorize_verified`, plus the sign-in facts the control plane reported (methods used, configured level...). Only the keys and shapes listed in
    /// `safe_auth_claims` are ever copied into the id_token: an extra can never set iss, sub, aud, exp or any other claim.
    pub fn authorize_verified_with(&self, client_id: &str, redirect_uri: &str, code_challenge: &str, username: &str, extra: &Value) -> Result<String, IdpError> {
        self.authorize_verified_on(client_id, redirect_uri, code_challenge, username, extra, None)
    }

    /// Like `authorize_verified_with`, plus the Dolt data branch this sign-in tested (see docs/branch-test.md). The branch comes from the
    /// authorization request parameters the core itself validated, NEVER from the control plane's extra: the `branch` claim it produces
    /// binds the issued token to that branch (the API refuses any other branch context with it).
    pub fn authorize_verified_on(&self, client_id: &str, redirect_uri: &str, code_challenge: &str, username: &str, extra: &Value, branch: Option<&str>) -> Result<String, IdpError> {
        if !self.check_client(client_id, redirect_uri) { return Err(IdpError::InvalidClient); }
        if code_challenge.len() < 43 { return Err(IdpError::InvalidRequest("code_challenge")); }
        let branch = branch.map(str::to_string);
        let code = rand_token();
        self.codes.lock().unwrap().insert(code.clone(), Code {
            user: username.into(), challenge: code_challenge.into(), redirect_uri: redirect_uri.into(),
            client_id: client_id.into(), exp: now() + 60, extra: safe_auth_claims(extra), branch });
        Ok(code)
    }

    /// Code exchange. The code is consumed even when the verifier is wrong (no retries).
    pub fn token(&self, code: &str, verifier: &str, redirect_uri: &str, client_id: &str) -> Result<Value, IdpError> {
        let c = self.codes.lock().unwrap().remove(code).ok_or(IdpError::InvalidGrant)?;
        let ok_pkce = B64.encode(Sha256::digest(verifier.as_bytes())) == c.challenge;
        if !ok_pkce || c.exp < now() || c.redirect_uri != redirect_uri || c.client_id != client_id { return Err(IdpError::InvalidGrant); }
        let t = now();
        let ttl = self.session_ttl(&c.extra);
        let mut claims = json!({"iss": self.issuer, "sub": c.user, "aud": c.client_id, "iat": t, "exp": t + ttl, "tenant": "acme-demo"});
        for (k, v) in c.extra { claims[k] = v; } // only keys that safe_auth_claims kept, none of which is a registered claim
        claims["auth_time"] = json!(t); // core-set: when the person really signed in. The absolute session limit counts from here.
        if let Some(b) = c.branch { claims["branch"] = json!(b); } // core-set, after the merge: the control plane can never plant it
        Ok(json!({"id_token": self.sign(&claims), "token_type": "Bearer", "expires_in": ttl}))
    }

    /// Renews a still valid session token (docs/session.md): same person, same claims, a fresh `iat`/`exp`.
    /// New expiry = `now + session_ttl`, never later than `auth_time + session_max` (which a renewal never moves).
    /// Refused when the token is invalid or expired, has no session limit, or the limit leaves no extra time.
    pub fn extend(&self, token: &str) -> Result<Value, IdpError> {
        let claims = verify(token, &self.jwks(), &self.issuer).ok_or(IdpError::InvalidGrant)?;
        let mut o = claims.as_object().cloned().ok_or(IdpError::InvalidGrant)?;
        let (auth_time, max) = (o.get("auth_time").and_then(Value::as_u64), o.get("session_max").and_then(Value::as_u64));
        let (Some(auth_time), Some(max)) = (auth_time, max) else { return Err(IdpError::InvalidGrant) };
        let (t, old_exp) = (now(), o.get("exp").and_then(Value::as_u64).unwrap_or(0));
        let ttl = self.session_ttl(&o);
        let new_exp = (t + ttl).min(auth_time + max);
        if new_exp <= old_exp.max(t) { return Err(IdpError::InvalidGrant); } // limit reached: nothing to add
        o.insert("iat".into(), json!(t)); o.insert("exp".into(), json!(new_exp));
        Ok(json!({"id_token": self.sign(&Value::Object(o)), "token_type": "Bearer", "expires_in": new_exp - t, "session_ends_at": auth_time + max}))
    }

    fn sign(&self, claims: &Value) -> String {
        let h = B64.encode(json!({"alg":"EdDSA","typ":"JWT","kid":"poc-1"}).to_string());
        let p = B64.encode(claims.to_string());
        let sig = self.key.sign(format!("{h}.{p}").as_bytes());
        format!("{h}.{p}.{}", B64.encode(sig.to_bytes()))
    }
}

/// Verify an EdDSA JWT against a JWKS document; returns claims if signature, issuer and expiry are valid.
pub fn verify(token: &str, jwks: &Value, issuer: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 { return None; }
    let header: Value = serde_json::from_slice(&B64.decode(parts[0]).ok()?).ok()?;
    if header["alg"] != "EdDSA" { return None; } // never accept "none" or other algs
    let x = jwks["keys"].as_array()?.iter().find(|k| k["kid"] == header["kid"])?["x"].as_str()?;
    let vk = VerifyingKey::from_bytes(&B64.decode(x).ok()?.try_into().ok()?).ok()?;
    let sig = Signature::from_bytes(&B64.decode(parts[2]).ok()?.try_into().ok()?);
    vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).ok()?;
    let claims: Value = serde_json::from_slice(&B64.decode(parts[1]).ok()?).ok()?;
    (claims["iss"] == issuer && claims["exp"].as_u64()? > now()).then_some(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    const REDIR: &str = "http://localhost:4200/callback";
    fn pkce() -> (String, String) {
        let v = rand_token() + &rand_token();
        (v.clone(), B64.encode(Sha256::digest(v.as_bytes())))
    }
    fn login(i: &Idp, ch: &str) -> String { i.authorize("demo-web", REDIR, ch, "demo-alice", "demo-only-not-a-secret").unwrap() }

    #[test]
    fn verified_gate_identity_still_checks_client_redirect_and_challenge() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        assert_eq!(i.authorize_verified("other", REDIR, &ch, "new-user"), Err(IdpError::InvalidClient));
        assert_eq!(i.authorize_verified("demo-web", "https://bad.invalid", &ch, "new-user"), Err(IdpError::InvalidClient));
        assert!(i.authorize_verified("demo-web", REDIR, "short", "new-user").is_err());
        let code = i.authorize_verified("demo-web", REDIR, &ch, "new-user").unwrap();
        let tok = i.token(&code, &v, REDIR, "demo-web").unwrap();
        assert_eq!(verify(tok["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap()["sub"], "new-user");
    }
    #[test]
    fn full_flow_and_verify() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        let tok = i.token(&login(&i, &ch), &v, REDIR, "demo-web").unwrap();
        let claims = verify(tok["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert_eq!(claims["sub"], "demo-alice");
        assert_eq!(claims["tenant"], "acme-demo");
    }
    #[test]
    fn wrong_verifier_rejected_and_code_burned() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        let code = login(&i, &ch);
        assert_eq!(i.token(&code, "wrong-verifier", REDIR, "demo-web").unwrap_err(), IdpError::InvalidGrant);
        assert_eq!(i.token(&code, &v, REDIR, "demo-web").unwrap_err(), IdpError::InvalidGrant);
    }
    #[test]
    fn code_is_single_use() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        let code = login(&i, &ch);
        i.token(&code, &v, REDIR, "demo-web").unwrap();
        assert!(i.token(&code, &v, REDIR, "demo-web").is_err());
    }
    #[test]
    fn bad_password_unknown_client_and_redirect() {
        let i = Idp::demo("http://idp.test");
        let (_, ch) = pkce();
        assert_eq!(i.authorize("demo-web", REDIR, &ch, "demo-alice", "nope").unwrap_err(), IdpError::InvalidCredentials);
        assert_eq!(i.authorize("evil", REDIR, &ch, "demo-alice", "demo-only-not-a-secret").unwrap_err(), IdpError::InvalidClient);
        assert_eq!(i.authorize("demo-web", "http://evil/cb", &ch, "demo-alice", "demo-only-not-a-secret").unwrap_err(), IdpError::InvalidClient);
    }
    #[test]
    fn auth_facts_are_whitelisted_and_cannot_override_registered_claims() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        let extra = json!({"amr":["pwd","otp"],"auth_level":7,"auth_mfa":true,"auth_chain":"mfa","sub":"evil","iss":"evil","exp":1,"tenant":"other","auth_level_declared":11,"auth_simulated":["<b>"],"role":"admin"});
        let code = i.authorize_verified_with("demo-web", REDIR, &ch, "demo-alice", &extra).unwrap();
        let claims = verify(i.token(&code, &v, REDIR, "demo-web").unwrap()["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert_eq!(claims["sub"], "demo-alice"); assert_eq!(claims["tenant"], "acme-demo"); assert_eq!(claims["iss"], "http://idp.test");
        assert_eq!(claims["auth_level"], 7); assert_eq!(claims["auth_mfa"], true); assert_eq!(claims["amr"], json!(["pwd", "otp"])); assert_eq!(claims["auth_chain"], "mfa");
        assert!(claims.get("role").is_none() && claims.get("auth_level_declared").is_none() && claims.get("auth_simulated").is_none()); // out of range / unsafe shapes dropped
        // no extras: the token is unchanged from before
        let code = i.authorize_verified("demo-web", REDIR, &ch, "demo-alice").unwrap();
        let claims = verify(i.token(&code, &v, REDIR, "demo-web").unwrap()["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert!(claims.get("amr").is_none() && claims.get("auth_level").is_none());
    }
    #[test]
    fn tampered_token_and_other_issuer_rejected() {
        let i = Idp::demo("http://idp.test");
        let (v, ch) = pkce();
        let tok = i.token(&login(&i, &ch), &v, REDIR, "demo-web").unwrap()["id_token"].as_str().unwrap().to_string();
        assert!(verify(&tok, &i.jwks(), "http://other").is_none());
        let mut parts: Vec<String> = tok.split('.').map(String::from).collect();
        parts[1] = B64.encode(json!({"iss":"http://idp.test","sub":"demo-bob","exp":9999999999u64}).to_string());
        assert!(verify(&parts.join("."), &i.jwks(), "http://idp.test").is_none());
        // a different key must not verify
        let j = Idp::demo("http://idp.test");
        assert!(verify(&tok, &j.jwks(), "http://idp.test").is_none());
    }
    #[test]
    fn configured_session_length_is_used_capped_and_bounded() {
        let signed = |i: &Idp, extra: Value| { let (v, ch) = pkce(); let code = i.authorize_verified_with("demo-web", REDIR, &ch, "demo-alice", &extra).unwrap(); i.token(&code, &v, REDIR, "demo-web").unwrap() };
        let i = Idp::demo("http://idp.test");
        let t = signed(&i, json!({"session_ttl": 1800, "session_warn": 120, "session_max": 28800}));
        assert_eq!(t["expires_in"], 1800);
        let c = verify(t["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert_eq!(c["exp"].as_u64().unwrap() - c["iat"].as_u64().unwrap(), 1800);
        assert_eq!((c["session_warn"].as_u64(), c["session_max"].as_u64(), c["auth_time"] == c["iat"]), (Some(120), Some(28800), true));
        assert_eq!(signed(&i, Value::Null)["expires_in"], 300);
        assert_eq!(signed(&i, json!({"session_ttl": 99_999_999u64}))["expires_in"], 300);
        assert_eq!(signed(&i, json!({"session_ttl": 1}))["expires_in"], 300);
        let capped = Idp::demo("http://idp.test").with_ttl_cap(60);
        assert_eq!(signed(&capped, json!({"session_ttl": 1800}))["expires_in"], 60);
    }
    #[test]
    fn extend_renews_the_token_within_the_absolute_limit() {
        let i = Idp::demo("http://idp.test"); let (v, ch) = pkce();
        let code = i.authorize_verified_with("demo-web", REDIR, &ch, "demo-alice", &json!({"session_ttl": 600, "session_max": 3600, "auth_level": 3})).unwrap();
        let old = i.token(&code, &v, REDIR, "demo-web").unwrap()["id_token"].as_str().unwrap().to_string();
        let oc = verify(&old, &i.jwks(), "http://idp.test").unwrap();
        let mut short = oc.as_object().unwrap().clone();
        short.insert("exp".into(), json!(now() + 60));
        let r = i.extend(&i.sign(&Value::Object(short))).unwrap();
        let nc = verify(r["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert_eq!((nc["sub"].clone(), nc["auth_level"].clone(), nc["auth_time"].clone()), (oc["sub"].clone(), json!(3), oc["auth_time"].clone()));
        assert!(nc["exp"].as_u64().unwrap() > now() + 590 && nc["exp"].as_u64().unwrap() <= now() + 600);
        assert_eq!(r["session_ends_at"].as_u64().unwrap(), oc["auth_time"].as_u64().unwrap() + 3600);
        let mut late = nc.as_object().unwrap().clone();
        late.insert("auth_time".into(), json!(now() - 3500)); late.insert("exp".into(), json!(now() + 30));
        let r = i.extend(&i.sign(&Value::Object(late))).unwrap();
        let lc = verify(r["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert!(lc["exp"].as_u64().unwrap() <= now() + 100);
        let mut last = lc.as_object().unwrap().clone(); last.insert("exp".into(), json!(lc["auth_time"].as_u64().unwrap() + 3600));
        assert_eq!(i.extend(&i.sign(&Value::Object(last))).unwrap_err(), IdpError::InvalidGrant);
    }
    #[test]
    fn extend_refuses_expired_forged_and_unlimited_tokens() {
        let i = Idp::demo("http://idp.test"); let other = Idp::demo("http://idp.test");
        assert_eq!(i.extend("garbage").unwrap_err(), IdpError::InvalidGrant);
        let mk = |idp: &Idp, exp: u64, with_max: bool| { let mut c = json!({"iss": "http://idp.test", "sub": "demo-alice", "aud": "demo-web", "iat": now() - 10, "exp": exp, "auth_time": now() - 10});
            if with_max { c["session_max"] = json!(3600); c["session_ttl"] = json!(600); } idp.sign(&c) };
        assert_eq!(i.extend(&mk(&i, now() - 1, true)).unwrap_err(), IdpError::InvalidGrant);
        assert_eq!(i.extend(&mk(&other, now() + 30, true)).unwrap_err(), IdpError::InvalidGrant);
        assert_eq!(i.extend(&mk(&i, now() + 30, false)).unwrap_err(), IdpError::InvalidGrant);
        assert!(i.extend(&mk(&i, now() + 30, true)).is_ok());
    }
    #[test]
    fn branch_claim_is_core_set_and_never_comes_from_the_control_plane_extra() {
        let i = Idp::demo("http://idp.test"); let (v, ch) = pkce();
        // the gate's extra cannot plant a branch
        let code = i.authorize_verified_with("demo-web", REDIR, &ch, "demo-alice", &json!({"branch": "evil"})).unwrap();
        let tok = i.token(&code, &v, REDIR, "demo-web").unwrap();
        let claims = verify(tok["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap();
        assert!(claims.get("branch").is_none());
        // the core's own parameter becomes the claim
        let (v2, ch2) = pkce();
        let code = i.authorize_verified_on("demo-web", REDIR, &ch2, "demo-alice", &Value::Null, Some("feature-x")).unwrap();
        let tok = i.token(&code, &v2, REDIR, "demo-web").unwrap();
        assert_eq!(verify(tok["id_token"].as_str().unwrap(), &i.jwks(), "http://idp.test").unwrap()["branch"], "feature-x");
    }
}

/// Detached Ed25519 signatures and SHA-256 helpers, reused by plugin package verification (same primitives as the IdP).
pub mod detached {
    use super::*;
    pub fn sha256_hex(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect() }
    /// base64url public key for a 32-byte seed (demo/test key generation; no key management here).
    pub fn public_key(seed: [u8; 32]) -> String { B64.encode(SigningKey::from_bytes(&seed).verifying_key().to_bytes()) }
    pub fn sign(seed: [u8; 32], msg: &[u8]) -> String { B64.encode(SigningKey::from_bytes(&seed).sign(msg).to_bytes()) }
    pub fn verify(public_key_b64: &str, msg: &[u8], sig_b64: &str) -> bool {
        let Some(vk) = B64.decode(public_key_b64).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).and_then(|b| VerifyingKey::from_bytes(&b).ok()) else { return false };
        let Some(sig) = B64.decode(sig_b64).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
        vk.verify(msg, &Signature::from_bytes(&sig)).is_ok()
    }

}
