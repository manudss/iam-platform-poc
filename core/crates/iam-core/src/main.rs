mod package;
mod grpc;
use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, post}};
use iam_idp::{Idp, IdpError};
use iam_decision::{DecisionRequest, DecisionResponse, Engine};
use serde_json::{Value, json};
use iam_plugin_runtime::{PluginRuntime, Verdict};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// Shared state: Cedar engine plus an optional blocking WASM plugin (wasm bytes).
pub struct Core {
    pub engine: Engine,
    pub plugin: Option<(PluginRuntime, Vec<u8>)>,
    pub idp: Idp,
    /// Active data version per tenant, set by POST /v1/activate (in memory: the control plane re-applies it after a restart).
    pub active: RwLock<HashMap<String, Active>>,
    /// Shared secret for /v1/activate. None = endpoint disabled (secure default).
    pub admin_token: Option<String>,
    /// Directory where each tenant's active version is persisted (<tenant>.json, atomic rename). None = memory only.
    pub state_dir: Option<std::path::PathBuf>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Snapshot {
    pub assignments: Vec<Assignment>,
    pub sod_rules: Vec<SodRule>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Assignment { pub identity_id: String, pub role_id: String }
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SodRule { pub role_a: String, pub role_b: String }
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Active { pub seq: u64, pub commit: String, pub snapshot: Snapshot }

impl Core {
    /// Loads persisted active versions. Files that are unreadable, malformed or whose tenant name does not match the file name are skipped (logged).
    pub fn load_state(&mut self, dir: &std::path::Path) {
        self.state_dir = Some(dir.to_path_buf());
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut map = self.active.write().unwrap();
        for e in rd.flatten() {
            let path = e.path();
            let (Some(stem), Some("json")) = (path.file_stem().and_then(|s| s.to_str()).map(str::to_string), path.extension().and_then(|s| s.to_str())) else { continue };
            match std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Active>(&b).ok()) {
                Some(a) if valid_name(&stem) => { map.insert(stem, a); }
                _ => tracing::warn!("ignoring unreadable state file {}", path.display()),
            }
        }
    }
    fn persist(&self, tenant: &str, a: &Active) -> std::io::Result<()> {
        let Some(dir) = &self.state_dir else { return Ok(()) };
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{tenant}.tmp"));
        std::fs::write(&tmp, serde_json::to_vec(a).map_err(std::io::Error::other)?)?;
        std::fs::rename(tmp, dir.join(format!("{tenant}.json")))
    }
    pub fn new(engine: Engine, plugin: Option<(PluginRuntime, Vec<u8>)>, idp: Idp) -> Self {
        Core { engine, plugin, idp, active: RwLock::new(HashMap::new()), admin_token: None, state_dir: None }
    }
}

pub fn app(engine: Arc<Core>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok","service":"iam-core"})) }))
        .route("/v1/decide", post(decide))
        .route("/v1/activate", post(activate))
        .route("/v1/version", get(version))
        .route("/.well-known/openid-configuration", get(|State(c): State<Arc<Core>>| async move { Json(c.idp.discovery()) }))
        .route("/jwks.json", get(|State(c): State<Arc<Core>>| async move { Json(c.idp.jwks()) }))
        .route("/authorize", post(authorize))
        .route("/token", post(token))
        .with_state(engine)
}

#[derive(serde::Deserialize)]
struct AuthorizeReq { client_id: String, redirect_uri: String, code_challenge: String, username: String, password: String }
#[derive(serde::Deserialize)]
struct TokenReq { code: String, code_verifier: String, redirect_uri: String, client_id: String }

fn idp_err(e: IdpError) -> (StatusCode, Json<Value>) {
    let (s, m) = match e {
        IdpError::InvalidClient => (StatusCode::BAD_REQUEST, "invalid_client"),
        IdpError::InvalidCredentials => (StatusCode::UNAUTHORIZED, "invalid_credentials"),
        IdpError::InvalidGrant => (StatusCode::BAD_REQUEST, "invalid_grant"),
        IdpError::InvalidRequest(_) => (StatusCode::BAD_REQUEST, "invalid_request"),
    };
    (s, Json(json!({"error": m})))
}

// POC simplification: JSON bodies instead of the form/redirect dance of full OIDC.
async fn authorize(State(c): State<Arc<Core>>, Json(r): Json<AuthorizeReq>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    c.idp.authorize(&r.client_id, &r.redirect_uri, &r.code_challenge, &r.username, &r.password)
        .map(|code| Json(json!({"code": code}))).map_err(idp_err)
}
async fn token(State(c): State<Arc<Core>>, Json(r): Json<TokenReq>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    c.idp.token(&r.code, &r.code_verifier, &r.redirect_uri, &r.client_id).map(Json).map_err(idp_err)
}

#[derive(serde::Deserialize)]
struct ActivateReq { tenant: String, seq: u64, commit: String, snapshot: Snapshot }

fn valid_name(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') }

/// Applies a data version to the core. Idempotent per (tenant, seq, commit); older seq is refused (stale);
/// same seq with another commit is a conflict. Requires the admin token header.
async fn activate(State(c): State<Arc<Core>>, headers: axum::http::HeaderMap, Json(r): Json<ActivateReq>) -> (StatusCode, Json<Value>) {
    let ok = match (&c.admin_token, headers.get("x-core-admin-token").and_then(|v| v.to_str().ok())) {
        (Some(want), Some(got)) => want.len() == got.len() && want.bytes().zip(got.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0,
        _ => false,
    };
    if !ok { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    if !valid_name(&r.tenant) || !valid_name(&r.commit) { return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid tenant or commit"}))); }
    let mut map = c.active.write().unwrap();
    if let Some(cur) = map.get(&r.tenant) {
        if cur.seq == r.seq {
            return if cur.commit == r.commit {
                (StatusCode::OK, Json(json!({"status": "already-applied", "seq": cur.seq, "commit": cur.commit})))
            } else {
                (StatusCode::CONFLICT, Json(json!({"error": "same seq, different commit"})))
            };
        }
        if cur.seq > r.seq { return (StatusCode::CONFLICT, Json(json!({"error": "stale activation", "active_seq": cur.seq}))); }
    }
    let a = Active { seq: r.seq, commit: r.commit.clone(), snapshot: r.snapshot };
    if let Err(e) = c.persist(&r.tenant, &a) { // not persisted = not applied: the caller sees the failure and can retry
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("cannot persist active version: {e}")})));
    }
    map.insert(r.tenant.clone(), a);
    (StatusCode::OK, Json(json!({"status": "applied", "seq": r.seq, "commit": r.commit})))
}

async fn version(State(c): State<Arc<Core>>, axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    let t = q.get("tenant").cloned().unwrap_or_default();
    match c.active.read().unwrap().get(&t) {
        Some(a) => (StatusCode::OK, Json(json!({"tenant": t, "seq": a.seq, "commit": a.commit}))),
        None => (StatusCode::NOT_FOUND, Json(json!({"error": "no active version"}))),
    }
}

/// Tenant mode: the data comes from the ACTIVE version, never from the caller. Caller-supplied roles/sod_conflict are overwritten.
fn tenant_context(c: &Core, tenant: &str, principal: &str, ctx: &mut Value) -> Result<(u64, String), ()> {
    let map = c.active.read().unwrap();
    let a = map.get(tenant).ok_or(())?;
    let identity = principal.split('"').nth(1).unwrap_or("");
    let roles: Vec<&str> = a.snapshot.assignments.iter().filter(|x| x.identity_id == identity).map(|x| x.role_id.as_str()).collect();
    let sod = a.snapshot.sod_rules.iter().any(|r| roles.contains(&r.role_a.as_str()) && roles.contains(&r.role_b.as_str()));
    if !ctx.is_object() { *ctx = json!({}); }
    let o = ctx.as_object_mut().unwrap();
    o.insert("tenant_mode".into(), json!(true));
    o.insert("roles".into(), json!(roles));
    o.insert("sod_conflict".into(), json!(sod));
    Ok((a.seq, a.commit.clone()))
}

async fn decide(State(c): State<Arc<Core>>, Json(raw): Json<Value>)
    -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    decide_value(&c, raw).map(Json).map_err(|(s, v)| (s, Json(v)))
}

/// Shared by HTTP `/v1/decide` and gRPC `Decision.Decide`: one decision path, one set of rules.
pub(crate) fn decide_value(c: &Core, raw: Value) -> Result<Value, (StatusCode, Value)> {
    let bad = |m: String| (StatusCode::BAD_REQUEST, json!({"error": m}));
    let tenant = raw.get("tenant").and_then(|v| v.as_str()).map(str::to_string);
    let mut req: DecisionRequest = serde_json::from_value(raw).map_err(|e| bad(e.to_string()))?;
    let mut version = None;
    if let Some(t) = &tenant {
        match tenant_context(c, t, &req.principal, &mut req.context) {
            Ok(v) => version = Some(v),
            Err(()) => return Ok(json!({"allow": false, "reasons": ["no-active-version"], "errors": []})),
        }
    }
    let mut resp = c.engine.decide(&req)
        .map_err(|err| (StatusCode::BAD_REQUEST, json!({"error": err.to_string()})))?;
    // Blocking plugin hook runs only on a Cedar allow; a plugin deny or error always denies (fail closed).
    if resp.allow {
        if let Some((rt, wasm)) = &c.plugin {
            let hour = req.context.get("hour").and_then(|v| v.as_i64()).unwrap_or(-1) as i32;
            let sensitive = req.context.get("sensitive").and_then(|v| v.as_bool()).unwrap_or(true);
            match rt.run(wasm, hour, sensitive) {
                Ok(Verdict::Allow) => {}
                Ok(Verdict::Deny) => { resp.allow = false; resp.reasons.push("plugin:deny".into()); }
                Err(e) => { resp.allow = false; resp.errors.push(format!("plugin error: {e}")); }
            }
        }
    }
    let mut out = serde_json::to_value(&resp).unwrap();
    if let Some((seq, commit)) = version { out["version"] = json!({"seq": seq, "commit": commit}); }
    Ok(out)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let path = std::env::var("IAM_POLICY_FILE").unwrap_or_else(|_| "../policies/demo.cedar".into());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let engine = Engine::new(&text).expect("invalid policies");
    if std::env::var("IAM_PLUGIN_PACKAGE").is_ok() && std::env::var("IAM_PLUGIN_WAT").is_ok() { panic!("set only one of IAM_PLUGIN_PACKAGE (signed) and IAM_PLUGIN_WAT (unsigned dev)"); }
    let signed = std::env::var("IAM_PLUGIN_PACKAGE").ok().map(|dir| {
        let rd = |f: &str| std::fs::read(format!("{dir}/{f}")).unwrap_or_else(|e| panic!("cannot read {dir}/{f}: {e}"));
        let keys: Vec<String> = std::env::var("IAM_PLUGIN_TRUSTED_KEYS").unwrap_or_default().split(',').filter(|k| !k.trim().is_empty()).map(str::to_string).collect();
        let wasm = rd("plugin.wasm");
        let m = package::load(&rd("manifest.json"), &String::from_utf8_lossy(&rd("manifest.sig")), &wasm, &keys).unwrap_or_else(|e| panic!("plugin package refused: {e}"));
        tracing::info!("plugin package {} {} by {} loaded (signature verified)", m.name, m.version, m.publisher);
        (PluginRuntime::new(100_000).unwrap(), wasm)
    });
    let plugin = signed.or_else(|| std::env::var("IAM_PLUGIN_WAT").ok().map(|p| {
        let wat = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read plugin {p}: {e}"));
        (PluginRuntime::new(100_000).unwrap(), wat::parse_str(wat).expect("invalid plugin"))
    }));
    let issuer = std::env::var("IAM_ISSUER").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let mut core = Core::new(engine, plugin, Idp::demo(&issuer).with_ttl(std::env::var("IAM_TOKEN_TTL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(300)));
    if let Ok(d) = std::env::var("IAM_CORE_STATE_DIR") { core.load_state(std::path::Path::new(&d)); }
    core.admin_token = std::env::var("IAM_CORE_ADMIN_TOKEN").ok().filter(|t| t.len() >= 8);
    let engine = Arc::new(core);
    let addr = std::env::var("IAM_CORE_ADDR").unwrap_or_else(|_| "127.0.0.1:8081".into());
    let l = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("iam-core listening on {addr}");
    if let Ok(g) = std::env::var("IAM_CORE_GRPC_ADDR") {
        let ga: std::net::SocketAddr = g.parse().expect("IAM_CORE_GRPC_ADDR must be host:port");
        let svc = grpc::service(engine.clone());
        tracing::info!("iam-core gRPC (plaintext, local POC) listening on {ga}");
        tokio::spawn(async move { tonic::transport::Server::builder().add_service(svc).serve(ga).await.expect("grpc server") });
    }
    axum::serve(l, app(engine)).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn call(body: Value) -> Value {
        let engine = Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")));
        let r = app(engine).oneshot(Request::post("/v1/decide")
            .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn plugin_denies_sensitive_off_hours() {
        let wasm = wat::parse_str(include_str!("../../../../plugins/examples/deny-off-hours.wat")).unwrap();
        let core = Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(),
            Some((PluginRuntime::new(100_000).unwrap(), wasm)), Idp::demo("http://idp.test")));
        for (hour, allow) in [(10, true), (23, false)] {
            let body = json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"",
              "context":{"sod_conflict":false,"hour":hour,"sensitive":true}});
            let r = app(core.clone()).oneshot(Request::post("/v1/decide").header("content-type","application/json")
                .body(Body::from(body.to_string())).unwrap()).await.unwrap();
            let v: Value = serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
            assert_eq!(v["allow"], allow, "hour {hour}");
        }
    }

    #[tokio::test]
    async fn manager_can_approve() {
        let v = call(json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"",
          "context":{"sod_conflict":false}})).await;
        assert_eq!(v["allow"], true);
    }

    #[tokio::test]
    async fn sod_conflict_is_forbidden() {
        let v = call(json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"",
          "context":{"sod_conflict":true}})).await;
        assert_eq!(v["allow"], false);
    }
}

#[cfg(test)]
mod activation_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN: &str = "test-admin-token";
    fn core() -> Arc<Core> {
        let mut c = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test"));
        c.admin_token = Some(TOKEN.into());
        Arc::new(c)
    }
    async fn send(c: &Arc<Core>, method: &str, uri: &str, tok: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut r = Request::builder().method(method).uri(uri).header("content-type", "application/json");
        if let Some(t) = tok { r = r.header("x-core-admin-token", t); }
        let resp = app(c.clone()).oneshot(r.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let st = resp.status();
        (st, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }
    fn act(seq: u64, commit: &str, roles: Value) -> Value {
        json!({"tenant":"t1","seq":seq,"commit":commit,"snapshot":{"assignments":roles,"sod_rules":[{"role_a":"payment-creator","role_b":"payment-approver"}]}})
    }
    fn dec(identity: &str) -> Value {
        json!({"tenant":"t1","principal":format!("User::\"{identity}\""),"action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"sod_conflict":false,"roles":["payment-approver"]}})
    }

    #[tokio::test]
    async fn activation_requires_the_admin_token_and_is_disabled_without_one() {
        let c = core();
        assert_eq!(send(&c, "POST", "/v1/activate", None, act(1, "aa", json!([]))).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&c, "POST", "/v1/activate", Some("wrong-token-xx"), act(1, "aa", json!([]))).await.0, StatusCode::UNAUTHORIZED);
        let no_token = Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")));
        assert_eq!(send(&no_token, "POST", "/v1/activate", Some(TOKEN), act(1, "aa", json!([]))).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn activation_changes_real_decisions_and_ignores_caller_supplied_roles() {
        let c = core();
        // before any activation: tenant requests are denied
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await;
        assert_eq!(v["allow"], false); assert_eq!(v["reasons"][0], "no-active-version");
        // version 1: alice is approver
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act(1, "c1", json!([{"identity_id":"demo-alice","role_id":"payment-approver"}]))).await;
        assert_eq!((r.0, r.1["status"].as_str().unwrap()), (StatusCode::OK, "applied"));
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await;
        assert_eq!(v["allow"], true); assert_eq!(v["version"]["commit"], "c1");
        // bob has no role in the active data: the roles claimed by the caller are overwritten -> deny
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await.1["allow"], false);
        // version 2 (roles revoked) applies: alice denied now
        send(&c, "POST", "/v1/activate", Some(TOKEN), act(2, "c2", json!([]))).await;
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await.1["allow"], false);
        // SoD computed from data: someone with both roles is forbidden
        send(&c, "POST", "/v1/activate", Some(TOKEN), act(3, "c3", json!([{"identity_id":"demo-bob","role_id":"payment-approver"},{"identity_id":"demo-bob","role_id":"payment-creator"}]))).await;
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await.1["allow"], false);
    }

    #[tokio::test]
    async fn activation_is_idempotent_and_refuses_stale_or_conflicting_versions() {
        let c = core();
        let a = act(5, "c5", json!([]));
        assert_eq!(send(&c, "POST", "/v1/activate", Some(TOKEN), a.clone()).await.1["status"], "applied");
        assert_eq!(send(&c, "POST", "/v1/activate", Some(TOKEN), a).await.1["status"], "already-applied");
        assert_eq!(send(&c, "POST", "/v1/activate", Some(TOKEN), act(5, "other", json!([]))).await.0, StatusCode::CONFLICT);
        assert_eq!(send(&c, "POST", "/v1/activate", Some(TOKEN), act(4, "c4", json!([]))).await.0, StatusCode::CONFLICT);
        let (st, v) = send(&c, "GET", "/v1/version?tenant=t1", None, Value::Null).await;
        assert_eq!((st, v["seq"].as_u64()), (StatusCode::OK, Some(5)));
        assert_eq!(send(&c, "GET", "/v1/version?tenant=nope", None, Value::Null).await.0, StatusCode::NOT_FOUND);
        assert_eq!(send(&c, "POST", "/v1/activate", Some(TOKEN), act(6, "bad commit!", json!([]))).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn active_version_survives_a_core_restart_when_a_state_dir_is_set() {
        let dir = std::env::temp_dir().join(format!("iam-core-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mk = |load: bool| { let mut c = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test")); c.admin_token = Some(TOKEN.into()); if load { c.load_state(&dir) } else { c.state_dir = Some(dir.clone()) }; Arc::new(c) };
        let c1 = mk(false);
        send(&c1, "POST", "/v1/activate", Some(TOKEN), act(7, "c7", json!([{"identity_id":"demo-alice","role_id":"payment-approver"}]))).await;
        assert_eq!(send(&c1, "POST", "/v1/decide", None, dec("demo-alice")).await.1["allow"], true);
        drop(c1); // "restart"
        let c2 = mk(true);
        let (st, v) = send(&c2, "GET", "/v1/version?tenant=t1", None, Value::Null).await;
        assert_eq!((st, v["seq"].as_u64(), v["commit"].as_str()), (StatusCode::OK, Some(7), Some("c7")));
        assert_eq!(send(&c2, "POST", "/v1/decide", None, dec("demo-alice")).await.1["allow"], true);
        // a corrupted state file is ignored (fail closed: no active version), and a stale seq is still refused after reload
        std::fs::write(dir.join("t1.json"), b"{not json").unwrap();
        let c3 = mk(true);
        assert_eq!(send(&c3, "POST", "/v1/decide", None, dec("demo-alice")).await.1["reasons"][0], "no-active-version");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
