//! Read-only rule catalogue (policy-studio step 1), the simulator (step 3) and the loader for one or several rule files.
//!   GET  /v1/policies          (admin token) -> { engine: {rules, sets, schema}, sets: [{name, rules}], rules: [RuleInfo...] }
//!   POST /v1/policies/simulate (admin token) -> Simulation: the decision the request WOULD get, plus why (every matching
//!        permit/forbid, errored rules, unlinked templates, one-sentence explanation). The simulator takes the request as given
//!        (principal, action, resource, context, entities): it never reads a tenant's active version - exploring a context
//!        the tenant did not apply is the point. Nothing is decided, recorded or changed.
//! Nothing here changes a decision: the catalogue is a view of what the engine loaded at startup.
//! Loading: IAM_POLICY_FILE is a file (one set named "default") or a directory (every `*.cedar` file is one set, named after the file).
//! Schema (policy-studio step 2): the rules are validated against a Cedar schema at load, and the core REFUSES to start on a rule the
//! schema rejects. The schema is `IAM_POLICY_SCHEMA` when set (a set but unreadable/invalid schema refuses the start too - never silently
//! skip a demanded check), else the sibling of the rules when it exists (`x.cedar` -> `x.cedarschema`, a directory -> `schema.cedarschema`
//! inside it), else no validation.
use crate::Core;
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}};
use iam_decision::{DecisionRequest, Engine, PolicySource};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// The schema that pairs with a rules path by convention: next to `demo.cedar` sits `demo.cedarschema`;
/// in a directory of sets it is `schema.cedarschema`.
pub fn default_schema_path(path: &Path) -> PathBuf {
    if path.extension().is_some_and(|x| x == "cedar") { path.with_extension("cedarschema") } else { path.join("schema.cedarschema") }
}

/// Load the rules and, when a schema applies, validate them before the engine can decide anything.
pub fn load_engine(path: &Path) -> Result<Engine, String> {
    let schema = match std::env::var("IAM_POLICY_SCHEMA") {
        Ok(p) => Some(PathBuf::from(p)),
        Err(_) => {
            let d = default_schema_path(path);
            if d.exists() { Some(d) } else { None }
        }
    };
    load_engine_with_schema(path, schema.as_deref())
}


/// `schema` None = no validation (legacy); Some(path) = validate, and an unreadable or invalid schema is an error.
pub fn load_engine_with_schema(path: &Path, schema: Option<&Path>) -> Result<Engine, String> {
    let schema_text = schema
        .map(|p| std::fs::read_to_string(p).map_err(|e| format!("cannot read schema {}: {e}", p.display())))
        .transpose()?;
    load_engine_from(path, schema_text)
}

fn load_engine_from(path: &Path, schema: Option<String>) -> Result<Engine, String> {
    load_sets(path).and_then(|sets| build(sets, schema))
}

fn load_sets(path: &Path) -> Result<Vec<PolicySource>, String> {
    if path.is_dir() {
        let mut files: Vec<_> = std::fs::read_dir(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?
            .filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "cedar")).collect();
        files.sort();
        let mut sets = Vec::new();
        for f in files {
            let stem = f.file_stem().and_then(|s| s.to_str()).ok_or_else(|| format!("bad file name {}", f.display()))?.to_ascii_lowercase();
            let text = std::fs::read_to_string(&f).map_err(|e| format!("cannot read {}: {e}", f.display()))?;
            sets.push(PolicySource { set: stem, text });
        }
        if sets.is_empty() { return Err(format!("no *.cedar file in {}", path.display())); }
        Ok(sets)
    } else {
        let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Ok(vec![PolicySource { set: "default".into(), text }])
    }
}

fn build(sets: Vec<PolicySource>, schema: Option<String>) -> Result<Engine, String> {
    match schema {
        Some(s) => Engine::from_sets_with_schema(&sets, &s).map_err(|e| e.to_string()),
        None => Engine::from_sets(&sets).map_err(|e| e.to_string()),
    }
}

pub async fn list(State(c): State<Arc<Core>>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let rules = c.engine.catalog();
    let mut sets: Vec<(String, usize)> = Vec::new();
    for r in rules { match sets.iter_mut().find(|(n, _)| *n == r.set) { Some(s) => s.1 += 1, None => sets.push((r.set.clone(), 1)) } }
    (StatusCode::OK, Json(json!({
        "engine": {"rules": rules.len(), "sets": sets.len(), "schema": c.engine.validated()},
        "sets": sets.iter().map(|(n, k)| json!({"name": n, "rules": k})).collect::<Vec<_>>(),
        "rules": rules,
    })))
}

/// Simulates a request against the loaded rules: the decision it would get and why (policy-studio step 3). Admin token.
pub async fn simulate(State(c): State<Arc<Core>>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let req: DecisionRequest = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid simulation request: {e}")}))),
    };
    match c.engine.simulate(&req) {
        Ok(s) => (StatusCode::OK, Json(serde_json::to_value(s).unwrap_or(Value::Null))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e.to_string()}))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use iam_idp::Idp;
    use tower::ServiceExt;

    const TOKEN: &str = "test-admin-token";
    const DEMO: &str = include_str!("../../../../policies/demo.cedar");
    const DEMO_SCHEMA: &str = include_str!("../../../../policies/demo.cedarschema");
    fn demo_core() -> Arc<Core> {
        let mut c = Core::new(Engine::new_with_schema(DEMO, DEMO_SCHEMA).unwrap(), None, Idp::demo("http://idp.test"));
        c.admin_token = Some(TOKEN.into());
        Arc::new(c)
    }
    async fn get(c: &Arc<Core>, tok: Option<&str>) -> (StatusCode, Value) {
        let mut r = Request::builder().method("GET").uri("/v1/policies");
        if let Some(t) = tok { r = r.header("x-core-admin-token", t); }
        let resp = crate::app(c.clone()).oneshot(r.body(Body::empty()).unwrap()).await.unwrap();
        let st = resp.status();
        (st, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn catalogue_needs_the_admin_token() {
        let c = demo_core();
        assert_eq!(get(&c, None).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(get(&c, Some("wrong-token-xx")).await.0, StatusCode::UNAUTHORIZED);
        let open = Arc::new(Core::new(Engine::new("").unwrap(), None, Idp::demo("http://idp.test")));
        assert_eq!(get(&open, Some(TOKEN)).await.0, StatusCode::UNAUTHORIZED, "no admin token configured: closed");
    }

    #[tokio::test]
    async fn catalogue_lists_every_demo_rule_with_a_readable_name() {
        let (st, v) = get(&demo_core(), Some(TOKEN)).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["engine"], json!({"rules": 6, "sets": 1, "schema": true}));
        let rules = v["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 6);
        for r in rules {
            assert!(!r["id"].as_str().unwrap().starts_with("policy"), "every demo rule is named: {r}");
            assert!(r["description"].is_string() && r["pillar"].is_string() && r["summary"].is_string(), "{r}");
        }
        let sod = rules.iter().find(|r| r["id"] == "sod-blocks-approve").unwrap();
        assert_eq!((sod["effect"].as_str(), sod["pillar"].as_str(), sod["kind"].as_str()), (Some("forbid"), Some("sod"), Some("policy")));
        assert!(sod["text"].as_str().unwrap().contains("context.sod_conflict == true"));
    }


    // ---- Schema at load (policy-studio step 2) ----

    #[test]
    fn default_schema_path_pairs_with_the_rules() {
        assert_eq!(default_schema_path(Path::new("/x/demo.cedar")), Path::new("/x/demo.cedarschema"));
        assert_eq!(default_schema_path(Path::new("/x/sets")), Path::new("/x/sets/schema.cedarschema"));
        assert_eq!(default_schema_path(Path::new("/x/sets/")), Path::new("/x/sets/schema.cedarschema"));
    }

    #[test]
    fn demo_policies_validate_against_their_schema() {
        // The shipped demo rules pass the shipped schema, through the same loader the core starts with.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../policies");
        let e = load_engine_with_schema(&root.join("demo.cedar"), Some(&root.join("demo.cedarschema"))).unwrap();
        assert!(e.validated());
        assert_eq!(e.catalog().len(), 5);
        // And the convention finds the sibling schema by itself.
        assert!(default_schema_path(&root.join("demo.cedar")).exists());
    }

    #[test]
    fn a_rule_the_schema_refuses_prevents_loading_and_names_the_rule() {
        let dir = std::env::temp_dir().join(format!("iam-schema-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("demo.cedar"), "@id(\"typo-rule\") permit(principal, action == Action::\"aprove\", resource);").unwrap();
        std::fs::write(dir.join("demo.cedarschema"), r#"entity User; entity Request; action "approve" appliesTo { principal: [User], resource: [Request] };"#).unwrap();
        let err = load_engine(&dir.join("demo.cedar")).err().unwrap();
        assert!(err.contains("typo-rule"), "{err}"); // the sibling schema applied by convention, error names the rule
        // An explicit schema path that does not exist refuses the start too (a demanded check is never skipped).
        assert!(load_engine_with_schema(&dir.join("demo.cedar"), Some(Path::new("/no/such/schema.cedarschema"))).is_err());
        // Pointing IAM_POLICY_FILE at rules with no schema anywhere keeps working without validation.
        std::fs::remove_file(dir.join("demo.cedarschema")).unwrap();
        let e = load_engine_with_schema(&dir.join("demo.cedar"), None).unwrap();
        assert!(!e.validated());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_decision_names_the_rule_that_decided() {
        let c = demo_core();
        let body = json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"sod_conflict":true}});
        let r = crate::app(c.clone()).oneshot(Request::post("/v1/decide").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let v: Value = serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(v["allow"], false);
        assert_eq!(v["reasons"], json!(["sod-blocks-approve"]));
    }

    // ---- Simulator endpoint (policy-studio step 3) ----

    async fn sim(c: &Arc<Core>, tok: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut r = Request::builder().method("POST").uri("/v1/policies/simulate").header("content-type", "application/json");
        if let Some(t) = tok { r = r.header("x-core-admin-token", t); }
        let resp = crate::app(c.clone()).oneshot(r.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let st = resp.status();
        (st, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn simulate_needs_the_admin_token_and_valid_input() {
        let c = demo_core();
        let body = json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"roles":["payment-approver"]}});
        assert_eq!(sim(&c, None, body.clone()).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(sim(&c, Some("wrong-token-xx"), body.clone()).await.0, StatusCode::UNAUTHORIZED);
        // A malformed request is a 400, never a panic nor a fake answer.
        assert_eq!(sim(&c, Some(TOKEN), json!({"principal": 42})).await.0, StatusCode::BAD_REQUEST);
        let (st, v) = sim(&c, Some(TOKEN), json!({"principal":"User::\"alice\"","action":"Action::\"aprove\"","resource":"Request::\"r1\""})).await;
        assert_eq!(st, StatusCode::OK, "an unknown action is a valid simulation input (the schema guards the rules, not the requests): {v}");
    }

    #[tokio::test]
    async fn simulate_explains_why_a_request_is_denied() {
        let c = demo_core();
        // Carol has no role and a SoD conflict: the forbid decides and no permit matched.
        let (st, v) = sim(&c, Some(TOKEN), json!({"principal":"User::\"carol\"","action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"roles":["viewer"],"sod_conflict":true}})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["allow"], false);
        assert_eq!(v["reasons"], json!(["sod-blocks-approve"]));
        assert_eq!(v["matched_forbids"], json!(["sod-blocks-approve"]));
        assert_eq!(v["matched_permits"], json!([]));
        assert!(v["explanation"].as_str().unwrap().contains("sod-blocks-approve"), "{v}");
        // Alice with the role and no conflict: allowed by the role permit; the demo rules do not apply because tenant_mode is set.
        let (st, v) = sim(&c, Some(TOKEN), json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"tenant_mode":true,"roles":["payment-approver"],"sod_conflict":false}})).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!((v["allow"].as_bool(), v["matched_permits"].as_array().unwrap().len()), (Some(true), 1));
        assert_eq!(v["matched_permits"], json!(["approve-needs-payment-approver"]));
        assert!(v["explanation"].as_str().unwrap().starts_with("ALLOWED by approve-needs-payment-approver"), "{v}");
        // The same alice WITHOUT tenant data: the static demo rule allows her instead.
        let (_, v) = sim(&c, Some(TOKEN), json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\""})).await;
        assert_eq!((v["allow"].as_bool(), v["matched_permits"].as_array().unwrap().len()), (Some(true), 1));
        assert_eq!(v["matched_permits"], json!(["demo-alice-approves"]));
    }

    #[test]
    fn a_directory_gives_one_set_per_file_and_forbid_crosses_sets() {
        let dir = std::env::temp_dir().join(format!("iam-policy-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Sso.cedar"), "@id(\"open-wiki\") permit(principal, action == Action::\"open\", resource);").unwrap();
        std::fs::write(dir.join("sod.cedar"), "@id(\"freeze\") forbid(principal, action, resource) when { context.frozen == true };").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a rule file").unwrap();
        let e = load_engine(&dir).unwrap();
        assert_eq!(e.catalog().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["sod/freeze", "sso/open-wiki"]);
        let ask = |frozen: bool| e.decide(&iam_decision::DecisionRequest { principal: "User::\"a\"".into(), action: "Action::\"open\"".into(), resource: "R::\"1\"".into(), context: json!({"frozen": frozen}), entities: json!([]) }).unwrap();
        assert!(ask(false).allow);
        assert_eq!(ask(true).reasons, vec!["sod/freeze".to_string()]);
        std::fs::write(dir.join("bad.cedar"), "permit(").unwrap();
        assert!(load_engine(&dir).is_err(), "a broken file refuses the whole load (no partial rule set)");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(load_engine(&std::env::temp_dir().join("iam-no-such-dir-xyz")).is_err());
    }
}
