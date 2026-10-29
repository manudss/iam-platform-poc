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

struct Code { user: String, challenge: String, redirect_uri: String, client_id: String, exp: u64 }

pub struct Idp {
    key: SigningKey,
    issuer: String,
    client_id: String,
    redirect_uris: Vec<String>,
    users: HashMap<String, String>, // username -> demo password (FICTIONAL, plain text on purpose: demo only)
    codes: Mutex<HashMap<String, Code>>,
    ttl: u64,
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
            redirect_uris: demo_redirect_uris(), users, codes: Mutex::new(HashMap::new()), ttl: 300,
        }
    }

    /// Token lifetime in seconds (local testing only, e.g. 1 to test expiry).
    pub fn with_ttl(mut self, ttl: u64) -> Self { self.ttl = ttl; self }

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
        if !self.check_client(client_id, redirect_uri) { return Err(IdpError::InvalidClient); }
        if code_challenge.len() < 43 { return Err(IdpError::InvalidRequest("code_challenge")); }
        let code = rand_token();
        self.codes.lock().unwrap().insert(code.clone(), Code {
            user: username.into(), challenge: code_challenge.into(), redirect_uri: redirect_uri.into(),
            client_id: client_id.into(), exp: now() + 60 });
        Ok(code)
    }

    /// Code exchange. The code is consumed even when the verifier is wrong (no retries).
    pub fn token(&self, code: &str, verifier: &str, redirect_uri: &str, client_id: &str) -> Result<Value, IdpError> {
        let c = self.codes.lock().unwrap().remove(code).ok_or(IdpError::InvalidGrant)?;
        let ok_pkce = B64.encode(Sha256::digest(verifier.as_bytes())) == c.challenge;
        if !ok_pkce || c.exp < now() || c.redirect_uri != redirect_uri || c.client_id != client_id { return Err(IdpError::InvalidGrant); }
        let t = now();
        let claims = json!({"iss": self.issuer, "sub": c.user, "aud": c.client_id, "iat": t, "exp": t + self.ttl, "tenant": "acme-demo"});
        Ok(json!({"id_token": self.sign(&claims), "token_type": "Bearer", "expires_in": self.ttl}))
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
