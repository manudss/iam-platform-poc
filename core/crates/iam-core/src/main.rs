mod bus_wiring;
mod package;
mod grpc;
mod authz;
mod policies;
pub mod gate;
use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, post}};
use iam_idp::{Idp, IdpError};
use iam_decision::{DecisionRequest, DecisionResponse, Engine, PolicyLink, PolicySource};
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
    /// Sign-in gate (loopback host:port, shared token). None = the IdP checks the password alone.
    pub gate: Option<(String, String)>,
    /// Event bus over NATS (step 1). None unless IAM_CORE_NATS_URL is set: behaviour is then unchanged.
    pub bus: Option<bus_wiring::BusLink>,
    /// The Cedar schema the boot rules were validated with (policy-studio step 4): candidate rules sent to
    /// /v1/policies/validate (and candidate simulations) are checked against the SAME schema. None = parse only.
    pub policy_schema: Option<String>,
    /// Per-tenant engines built from the active version's policies (step 4). A tenant without an entry here decides
    /// with the boot engine (the file = the fallback set).
    pub engines: RwLock<HashMap<String, Arc<Engine>>>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Snapshot {
    pub assignments: Vec<Assignment>,
    pub sod_rules: Vec<SodRule>,
    /// MCP gateway (P2): delegation grants versioned with the rest of the data. Older snapshots lack the field.
    #[serde(default)]
    pub mcp_grants: Vec<McpGrant>,
    /// Policy-studio step 4: the tenant's Cedar rule sets, versioned in Dolt like the rest. Absent in older snapshots:
    /// the tenant then decides with the boot rules (the file stays the fallback set). Present but unbuildable
    /// (parse or schema error) = the activation is REFUSED and the previous version keeps serving.
    #[serde(default)]
    pub policies: Option<Vec<PolicySource>>,
    /// Template links of the tenant (per person, role or organisation). Only meaningful with `policies`.
    #[serde(default)]
    pub policy_links: Vec<PolicyLink>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Assignment { pub identity_id: String, pub role_id: String }
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SodRule { pub role_a: String, pub role_b: String }
/// One delegation grant: identity may invoke `upstream__tool` on the relayed MCP, until `expires_ms` (None = no expiry).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct McpGrant { pub identity_id: String, pub upstream: String, pub tool: String, pub expires_ms: Option<i64> }
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Active { pub seq: u64, pub commit: String, pub snapshot: Snapshot }

impl Core {
    /// Builds the tenant's engine from its snapshot policies (policy-studio step 4), validated with the boot schema.
    /// None policies = no tenant engine (boot rules serve this tenant). An unbuildable set is an error naming the rule:
    /// the caller refuses the activation and the previous version keeps serving (fail closed).
    fn tenant_engine(&self, snapshot: &Snapshot) -> Result<Option<Engine>, String> {
        let Some(sets) = &snapshot.policies else { return Ok(None) };
        let e = match &self.policy_schema {
            Some(schema) => Engine::from_sets_with_schema_and_links(sets, schema, &snapshot.policy_links).map_err(|e| e.to_string()),
            None => Engine::from_sets_and_links(sets, &snapshot.policy_links).map_err(|e| e.to_string()),
        }?;
        Ok(Some(e))
    }

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
        drop(map);
        // Rebuild the per-tenant engines (step 4). A version whose rules no longer build (e.g. the schema changed)
        // is dropped entirely: the tenant answers no-active-version rather than silently deciding with other rules.
        let tenants: Vec<String> = self.active.read().unwrap().keys().cloned().collect();
        for t in tenants {
            let snapshot = self.active.read().unwrap().get(&t).unwrap().snapshot.clone();
            match self.tenant_engine(&snapshot) {
                Ok(Some(e)) => { self.engines.write().unwrap().insert(t, Arc::new(e)); }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!("active version of {t} dropped: its rules no longer build: {e}");
                    self.active.write().unwrap().remove(&t);
                }
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
    /// Tells the bus about something that really happened. Never blocks, never fails the caller; no bus = nothing happens.
    pub fn bus_emit(&self, kind: &'static str, payload: Value, effect_key: Option<String>) {
        if let Some(b) = &self.bus { b.emit(kind, payload, effect_key); }
    }
    pub fn new(engine: Engine, plugin: Option<(PluginRuntime, Vec<u8>)>, idp: Idp) -> Self {
        Core { engine, plugin, idp, active: RwLock::new(HashMap::new()), admin_token: None, state_dir: None, gate: None, bus: None, policy_schema: None, engines: RwLock::new(HashMap::new()) }
    }
}

pub fn app(engine: Arc<Core>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok","service":"iam-core"})) }))
        .route("/v1/decide", post(decide))
        .route("/v1/policies", get(policies::list))
        .route("/v1/policies/simulate", post(policies::simulate))
        .route("/v1/policies/validate", post(policies::validate))
        .route("/v1/activate", post(activate))
        .route("/v1/version", get(version))
        .route("/v1/bus", get(bus_wiring::status))
        .route("/v1/bus/records", get(bus_wiring::records))
        .route("/v1/bus/plugins/register", post(bus_wiring::register))
        .route("/v1/bus/plugins/unregister", post(bus_wiring::unregister))
        .route("/v1/bus/plugins", get(bus_wiring::plugins))
        .route("/v1/bus/emit", post(bus_wiring::emit_http))
        .route("/.well-known/openid-configuration", get(|State(c): State<Arc<Core>>| async move { Json(c.idp.discovery()) }))
        .route("/jwks.json", get(|State(c): State<Arc<Core>>| async move { Json(c.idp.jwks()) }))
        .route("/authorize", post(authorize).get(authz::authorize_form))
        .route("/authorize/login", post(authz::login))
        .route("/authorize/theme", get(authz::set_theme))
        .route("/token", post(token))
        .route("/session/extend", post(session_extend))
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
    let mut extra = Value::Null;
    if let Some((addr, tok)) = &c.gate {
        match gate::check(addr, tok, "acme-demo", &r.username, &r.password).await {
            gate::Gate::Allow(claims) => { extra = claims; }
            gate::Gate::Deny => return Err(idp_err(IdpError::InvalidCredentials)),
            gate::Gate::Unavailable => return Err((StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "temporarily_unavailable"})))),
        }
    }
    (if c.gate.is_some() { c.idp.authorize_verified_with(&r.client_id, &r.redirect_uri, &r.code_challenge, &r.username, &extra) } else { c.idp.authorize(&r.client_id, &r.redirect_uri, &r.code_challenge, &r.username, &r.password) })
        .map(|code| Json(json!({"code": code}))).map_err(idp_err)
}
async fn token(State(c): State<Arc<Core>>, Json(r): Json<TokenReq>) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    c.idp.token(&r.code, &r.code_verifier, &r.redirect_uri, &r.client_id).map(Json).map_err(idp_err)
}

/// Session renewal (docs/session.md): the bearer token itself is the credential (signature, issuer and expiry are checked by the IdP).
/// 401 when the token is missing, invalid or expired; 409 when the absolute session limit leaves no extra time.
async fn session_extend(State(c): State<Arc<Core>>, headers: axum::http::HeaderMap) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let tok = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    let who = iam_idp::verify(tok, &c.idp.jwks(), c.idp.issuer()).ok_or((StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid_token"}))))?;
    match c.idp.extend(tok) {
        Ok(v) => { c.bus_emit("session.extended", json!({"subject": who["sub"], "expires_in": v["expires_in"]}), None); Ok(Json(v)) }
        Err(_) => Err((StatusCode::CONFLICT, Json(json!({"error": "session_limit_reached"})))),
    }
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
    // Policy-studio step 4: rules travel with the version. Build the tenant engine FIRST: an unbuildable set refuses
    // the activation (400 naming the rule) and the previous version keeps serving - a broken rules push never decides.
    let engine = match c.tenant_engine(&r.snapshot) {
        Ok(e) => e,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("policy rules refused: {e}")}))),
    };
    let a = Active { seq: r.seq, commit: r.commit.clone(), snapshot: r.snapshot };
    if let Err(e) = c.persist(&r.tenant, &a) { // not persisted = not applied: the caller sees the failure and can retry
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("cannot persist active version: {e}")})));
    }
    match engine {
        Some(e) => { c.engines.write().unwrap().insert(r.tenant.clone(), Arc::new(e)); }
        None => { c.engines.write().unwrap().remove(&r.tenant); } // a version without rules reverts to the boot set
    }
    map.insert(r.tenant.clone(), a);
    c.bus_emit("activation.applied", json!({"tenant": r.tenant, "seq": r.seq, "commit": r.commit}), Some(format!("activation:{}:{}", r.tenant, r.seq)));
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
    // MCP gateway (P2): the live grants of THIS identity, as Cedar entities (UpstreamTool::"<upstream>__<tool>").
    // Expired grants never reach the context; the policy requires role mcp-operator AND the grant (see demo.cedar).
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let grants: Vec<Value> = a.snapshot.mcp_grants.iter()
        .filter(|g| g.identity_id == identity && g.expires_ms.map(|x| x > now).unwrap_or(true))
        .map(|g| json!({"__entity": {"type": "UpstreamTool", "id": format!("{}__{}", g.upstream, g.tool)}}))
        .collect();
    if !ctx.is_object() { *ctx = json!({}); }
    let o = ctx.as_object_mut().unwrap();
    o.insert("tenant_mode".into(), json!(true));
    o.insert("roles".into(), json!(roles));
    o.insert("sod_conflict".into(), json!(sod));
    o.insert("mcp_grants".into(), json!(grants));
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
    // Optional caller audit meta (step 3): the API stamps who asked (source, note, subject); it rides in the
    // access.decided bus event so the trail keeps the caller context. Never trusted for the decision itself.
    let audit_meta = raw.get("audit").cloned();
    let mut req: DecisionRequest = serde_json::from_value(raw).map_err(|e| bad(e.to_string()))?;
    let mut version = None;
    if let Some(t) = &tenant {
        match tenant_context(c, t, &req.principal, &mut req.context) {
            Ok(v) => version = Some(v),
            Err(()) => {
                emit_decision(c, tenant.as_deref(), &req, false, &["no-active-version".to_string()], None, audit_meta.as_ref());
                return Ok(json!({"allow": false, "reasons": ["no-active-version"], "errors": []}));
            }
        }
    }
    let tenant_engine = tenant.as_ref().and_then(|t| c.engines.read().unwrap().get(t).cloned());
    let engine = tenant_engine.as_deref().unwrap_or(&c.engine);
    let mut resp = engine.decide(&req)
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
    if let Some((seq, commit)) = &version { out["version"] = json!({"seq": seq, "commit": commit}); }
    emit_decision(c, tenant.as_deref(), &req, resp.allow, &resp.reasons, version.as_ref(), audit_meta.as_ref());
    Ok(out)
}

/// Step 3: every decision (allow or deny, HTTP or gRPC) is emitted on the bus as access.decided, durable and
/// at-least-once. The payload never carries the request context (it may hold personal data) - only the inputs
/// that identify the request, mirroring the API's decision_audit rule.
fn emit_decision(c: &Core, tenant: Option<&str>, req: &DecisionRequest, allow: bool, reasons: &[String], version: Option<&(u64, String)>, audit_meta: Option<&Value>) {
    if c.bus.is_none() { return; }
    let mut p = json!({"principal": req.principal, "action": req.action, "resource": req.resource, "allow": allow, "reasons": reasons});
    if let Some(t) = tenant { p["tenant"] = json!(t); }
    if let Some((seq, commit)) = version { p["seq"] = json!(seq); p["commit"] = json!(commit); }
    if let Some(a) = audit_meta {
        for k in ["source", "note", "subject"] { if let Some(v) = a.get(k) { p[k] = v.clone(); } }
    }
    if tenant.is_none() { if let Some(t) = audit_meta.and_then(|a| a.get("tenant")) { p["tenant"] = t.clone(); } }
    c.bus_emit("access.decided", p, None);
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let path = std::env::var("IAM_POLICY_FILE").unwrap_or_else(|_| "../policies/demo.cedar".into());
    let (engine, policy_schema) = policies::load_engine_and_schema(std::path::Path::new(&path)).unwrap_or_else(|e| panic!("invalid policies ({path}): {e}"));
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
    let mut core = Core::new(engine, plugin, match std::env::var("IAM_TOKEN_TTL_SECS").ok().and_then(|v| v.parse::<u64>().ok()) { Some(t) => Idp::demo(&issuer).with_ttl(t).with_ttl_cap(t), None => Idp::demo(&issuer) });
    core.policy_schema = policy_schema;
    if let Ok(g) = std::env::var("IAM_AUTH_GATE_ADDR") {
        let addr = gate::parse_addr(&g).expect("IAM_AUTH_GATE_ADDR must be a loopback host:port");
        let tok = std::env::var("IAM_AUTH_GATE_TOKEN").ok().filter(|t| t.len() >= 8).expect("IAM_AUTH_GATE_TOKEN (>= 8 chars) is required with a gate");
        core.gate = Some((addr, tok));
    }
    if let Ok(d) = std::env::var("IAM_CORE_STATE_DIR") { core.load_state(std::path::Path::new(&d)); }
    core.admin_token = std::env::var("IAM_CORE_ADMIN_TOKEN").ok().filter(|t| t.len() >= 8);
    if let Ok(url) = std::env::var("IAM_CORE_NATS_URL") {
        let user = std::env::var("IAM_CORE_NATS_USER").unwrap_or_else(|_| "core".into());
        let pass = std::env::var("IAM_CORE_NATS_PASSWORD").unwrap_or_default();
        // Step 3 (decision: NATS is a base process, always up): a configured bus that cannot connect is a FATAL
        // error, not a degraded mode. The core exits; the start scripts bring NATS up first and restart the core.
        // Without IAM_CORE_NATS_URL the core still starts (pure decision tests); a warning says the bus is off.
        match bus_wiring::BusLink::connect(&url, &user, &pass).await {
            Ok(b) => { tracing::info!("core bus connected to NATS {url}"); core.bus = Some(b); }
            Err(e) => panic!("NATS is a base process and must be running before the core starts: {e}. Start nats-server first (scripts/demo-start.sh), then restart the core."),
        }
    } else {
        tracing::warn!("IAM_CORE_NATS_URL is not set: the event bus is OFF (decisions and the IdP still work; nothing is audited on the bus and no plugin is served)");
    }
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
    async fn session_extend_needs_a_valid_token_and_a_session_limit() {
        let idp = Idp::demo("http://idp.test");
        let sign_in = |extra: Value| { let (v, ch) = ("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"); // RFC 7636 example pair
            let code = idp.authorize_verified_with("demo-web", "http://localhost:4200/callback", ch, "demo-alice", &extra).unwrap();
            idp.token(&code, v, "http://localhost:4200/callback", "demo-web").unwrap()["id_token"].as_str().unwrap().to_string() };
        let unlimited = sign_in(Value::Null);
        let c = Arc::new(Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, idp));
        let call = |bearer: Option<&str>| { let c = c.clone(); let b = bearer.map(|b| format!("Bearer {b}")); async move {
            let mut r = Request::builder().method("POST").uri("/session/extend");
            if let Some(b) = b { r = r.header("authorization", b); }
            app(c).oneshot(r.body(Body::empty()).unwrap()).await.unwrap().status() } };
        assert_eq!(call(None).await, StatusCode::UNAUTHORIZED);
        assert_eq!(call(Some("not.a.token")).await, StatusCode::UNAUTHORIZED);
        assert_eq!(call(Some(&unlimited)).await, StatusCode::CONFLICT); // issued without a session limit: nothing to extend
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

    fn act_grants(seq: u64, commit: &str, roles: Value, grants: Value) -> Value {
        json!({"tenant":"t1","seq":seq,"commit":commit,"snapshot":{"assignments":roles,"sod_rules":[],"mcp_grants":grants}})
    }
    fn dec_proxy(identity: &str, tool: &str) -> Value {
        json!({"tenant":"t1","principal":format!("User::\"{identity}\""),"action":"Action::\"mcp:proxy\"","resource":format!("UpstreamTool::\"{tool}\""),"context":{}})
    }

    #[tokio::test]
    async fn mcp_proxy_requires_a_live_grant_from_the_active_version() {
        let c = core();
        let operator = json!([{"identity_id":"demo-alice","role_id":"mcp-operator"}]);
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 + 3_600_000;
        // v1: role but NO grant -> every relayed call is denied, even with the role.
        send(&c, "POST", "/v1/activate", Some(TOKEN), act_grants(1, "g1", operator.clone(), json!([]))).await;
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__getIssue")).await.1["allow"], false, "role without grant");
        // v2: grant fake__getIssue (no expiry) -> allowed, and only that exact tool.
        send(&c, "POST", "/v1/activate", Some(TOKEN), act_grants(2, "g2", operator.clone(),
            json!([{"identity_id":"demo-alice","upstream":"fake","tool":"getIssue","expires_ms":null},
                   {"identity_id":"demo-bob","upstream":"fake","tool":"searchIssues","expires_ms":null},
                   {"identity_id":"demo-alice","upstream":"fake","tool":"searchIssues","expires_ms":future},
                   {"identity_id":"demo-alice","upstream":"fake","tool":"createIssue","expires_ms":1}]))).await;
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__getIssue")).await.1["allow"], true, "granted tool");
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__searchIssues")).await.1["allow"], true, "unexpired timed grant");
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__createIssue")).await.1["allow"], false, "expired grant (expires_ms=1)");
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__deleteIssue")).await.1["allow"], false, "tool not granted");
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "other__getIssue")).await.1["allow"], false, "another upstream");
        // bob has the grant but NOT the mcp-operator role -> denied.
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-bob", "fake__searchIssues")).await.1["allow"], false, "grant without role");
        // v3: grants revoked by a new active version -> denied again (versioning decides, not the caller).
        send(&c, "POST", "/v1/activate", Some(TOKEN), act_grants(3, "g3", operator.clone(), json!([]))).await;
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec_proxy("demo-alice", "fake__getIssue")).await.1["allow"], false, "grant revoked by activation");
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

    // ---- Policy-studio step 4: rules travel with the active version ----

    fn act_rules(seq: u64, commit: &str, policies: Value, links: Value) -> Value {
        json!({"tenant":"t1","seq":seq,"commit":commit,"snapshot":{"assignments":[],"sod_rules":[],"policies":policies,"policy_links":links}})
    }
    const TENANT_RULES: &str = r#"@id("tenant-bob-approves") permit(principal == User::"demo-bob", action == Action::"approve", resource);"#;

    #[tokio::test]
    async fn a_version_can_carry_rules_and_a_broken_push_never_decides() {
        let c = core();
        // Version 1 carries its own rules: only demo-bob may approve (the boot demo rules no longer apply to t1).
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act_rules(1, "r1", json!([{"set":"default","text":TENANT_RULES}]), json!([]))).await;
        assert_eq!((r.0, r.1["status"].as_str()), (StatusCode::OK, Some("applied")), "{:?}", r.1);
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await;
        assert_eq!((v["allow"].as_bool(), v["reasons"][0].as_str()), (Some(true), Some("tenant-bob-approves")));
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await.1["allow"], false, "the boot rules no longer serve t1");
        // The catalogue names the tenant's applied rules; without ?tenant it still shows the boot set.
        let (_, v) = send(&c, "GET", "/v1/policies?tenant=t1", Some(TOKEN), Value::Null).await;
        assert_eq!((v["engine"]["source"].as_str(), v["engine"]["rules"].as_u64()), (Some("tenant"), Some(1)));
        let (_, v) = send(&c, "GET", "/v1/policies", Some(TOKEN), Value::Null).await;
        assert_eq!(v["engine"]["source"].as_str(), Some("boot"));
        // The simulator follows the tenant's rules too.
        let (_, v) = send(&c, "POST", "/v1/policies/simulate", Some(TOKEN), json!({"tenant":"t1","principal":"User::\"demo-bob\"","action":"Action::\"approve\"","resource":"Request::\"r1\""})).await;
        assert_eq!((v["allow"].as_bool(), v["engine_of"].as_str()), (Some(true), Some("tenant")));
        // Version 2 with a BROKEN rule set: refused (400 naming the rule), version 1 keeps serving.
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act_rules(2, "r2", json!([{"set":"default","text":"permit("}]), json!([]))).await;
        assert_eq!(r.0, StatusCode::BAD_REQUEST);
        assert!(r.1["error"].as_str().unwrap().contains("policy rules refused"), "{:?}", r.1);
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await;
        assert_eq!((v["allow"].as_bool(), v["version"]["commit"].as_str()), (Some(true), Some("r1")), "the previous version keeps serving");
        // Version 3 WITHOUT rules: the tenant reverts to the boot set (the tenant-mode demo rule decides again).
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act(3, "r3", json!([{"identity_id":"demo-alice","role_id":"payment-approver"}]))).await;
        assert_eq!(r.1["status"], "applied");
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await;
        assert_eq!((v["allow"].as_bool(), v["reasons"][0].as_str()), (Some(true), Some("approve-needs-payment-approver")));
        let (_, v) = send(&c, "GET", "/v1/policies?tenant=t1", Some(TOKEN), Value::Null).await;
        assert_eq!(v["engine"]["source"].as_str(), Some("boot"));
    }

    #[tokio::test]
    async fn version_rules_are_checked_against_the_boot_schema_and_links_work() {
        let mut cc = Core::new(Engine::new_with_schema(include_str!("../../../../policies/demo.cedar"), include_str!("../../../../policies/demo.cedarschema")).unwrap(), None, Idp::demo("http://idp.test"));
        cc.admin_token = Some(TOKEN.into());
        cc.policy_schema = Some(include_str!("../../../../policies/demo.cedarschema").into());
        let c = Arc::new(cc);
        // A rule the schema refuses fails the activation and names the rule.
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act_rules(1, "r1", json!([{"set":"default","text":"@id(\"typo\") permit(principal, action == Action::\"aprove\", resource);"}]), json!([]))).await;
        assert_eq!(r.0, StatusCode::BAD_REQUEST);
        assert!(r.1["error"].as_str().unwrap().contains("typo"), "{:?}", r.1);
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await.1["reasons"][0], "no-active-version");
        // A template + a per-person link in the version: the grant decides and the audit names the link.
        let rules = r#"@id("delegated-approve") permit(principal == ?principal, action == Action::"approve", resource);"#;
        let links = json!([{"id":"delegate:demo-bob","template":"delegated-approve","values":{"principal":"User::\"demo-bob\""}}]);
        let r = send(&c, "POST", "/v1/activate", Some(TOKEN), act_rules(1, "r1", json!([{"set":"default","text":rules}]), links)).await;
        assert_eq!((r.0, r.1["status"].as_str()), (StatusCode::OK, Some("applied")), "{:?}", r.1);
        let (_, v) = send(&c, "POST", "/v1/decide", None, dec("demo-bob")).await;
        assert_eq!((v["allow"].as_bool(), v["reasons"][0].as_str()), (Some(true), Some("delegate:demo-bob")));
        assert_eq!(send(&c, "POST", "/v1/decide", None, dec("demo-alice")).await.1["allow"], false);
    }

    #[tokio::test]
    async fn tenant_rules_are_rebuilt_after_a_restart_and_dropped_if_they_no_longer_build() {
        let dir = std::env::temp_dir().join(format!("iam-core-state-pol-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mk = |load: bool, schema: bool| {
            let mut c = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test"));
            c.admin_token = Some(TOKEN.into());
            if schema { c.policy_schema = Some(include_str!("../../../../policies/demo.cedarschema").into()); }
            if load { c.load_state(&dir) } else { c.state_dir = Some(dir.clone()) }
            Arc::new(c)
        };
        // Activate a version carrying rules (no schema configured at this point: parse-only), then "restart".
        let c1 = mk(false, false);
        send(&c1, "POST", "/v1/activate", Some(TOKEN), act_rules(9, "p9", json!([{"set":"default","text":TENANT_RULES}]), json!([]))).await;
        assert_eq!(send(&c1, "POST", "/v1/decide", None, dec("demo-bob")).await.1["allow"], true);
        drop(c1);
        // After the restart the tenant rules still decide (rebuilt from the persisted version).
        let c2 = mk(true, false);
        let (_, v) = send(&c2, "POST", "/v1/decide", None, dec("demo-bob")).await;
        assert_eq!((v["allow"].as_bool(), v["reasons"][0].as_str()), (Some(true), Some("tenant-bob-approves")));
        drop(c2);
        // If the rules can no longer be built at load (here: a schema appears and the persisted set does not match it),
        // the version is dropped: fail closed with no-active-version, never a silent fallback to other rules.
        std::fs::write(dir.join("t1.json"), serde_json::to_vec(&json!({"seq":9,"commit":"p9","snapshot":{"assignments":[],"sod_rules":[],"policies":[{"set":"default","text":"permit(principal, action == Action::\"nope\", resource);"}],"policy_links":[]}})).unwrap()).unwrap();
        let c3 = mk(true, true);
        assert_eq!(send(&c3, "POST", "/v1/decide", None, dec("demo-bob")).await.1["reasons"][0], "no-active-version");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
