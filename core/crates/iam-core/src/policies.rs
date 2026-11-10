//! Read-only rule catalogue (policy-studio step 1), the simulator (step 3), candidate validation (step 4) and the loader.
//!   GET  /v1/policies           (admin token) -> { engine: {rules, sets, schema}, sets: [{name, rules}], rules: [RuleInfo...] }
//!   POST /v1/policies/simulate  (admin token) -> Simulation: the decision the request WOULD get, plus why (every matching
//!        permit/forbid, errored rules, unlinked templates, one-sentence explanation). The simulator takes the request as given
//!        (principal, action, resource, context, entities): it never reads a tenant's active version - exploring a context
//!        the tenant did not apply is the point. With an optional `policies` body field ({sets, links}) it evaluates the CANDIDATE
//!        rules instead of the loaded ones, so a branch's rules can be checked before they are applied. Nothing is decided,
//!        recorded or changed.
//!   POST /v1/policies/validate  (admin token) -> dry-run build of candidate rules ({sets, links}) against the schema the core
//!        loaded: 200 with the candidate's catalogue (ids, summaries) or 400 with the error NAMING the rule. Nothing is swapped.
//! Nothing here changes a decision: the catalogue is a view of what the engine loaded, validation and candidate simulation build
//! a throwaway engine and drop it.
//! Loading: IAM_POLICY_FILE is a file (one set named "default") or a directory (every `*.cedar` file is one set, named after the file).
//! Schema (policy-studio step 2): the rules are validated against a Cedar schema at load, and the core REFUSES to start on a rule the
//! schema rejects. The schema is `IAM_POLICY_SCHEMA` when set (a set but unreadable/invalid schema refuses the start too - never silently
//! skip a demanded check), else the sibling of the rules when it exists (`x.cedar` -> `x.cedarschema`, a directory -> `schema.cedarschema`
//! inside it), else no validation.
use crate::Core;
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}};
use iam_decision::{DecisionRequest, Engine, PolicyLink, PolicySource};
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
    Ok(load_engine_and_schema(path)?.0)
}

/// Same as load_engine, also returning the schema text (None when no schema applies) so the core can validate
/// candidate rules with the very same schema (policy-studio step 4: /v1/policies/validate and candidate simulation).
pub fn load_engine_and_schema(path: &Path) -> Result<(Engine, Option<String>), String> {
    let schema = match std::env::var("IAM_POLICY_SCHEMA") {
        Ok(p) => Some(PathBuf::from(p)),
        Err(_) => {
            let d = default_schema_path(path);
            if d.exists() { Some(d) } else { None }
        }
    };
    let schema_text = schema
        .map(|p| std::fs::read_to_string(&p).map_err(|e| format!("cannot read schema {}: {e}", p.display())))
        .transpose()?;
    let engine = load_engine_from(path, schema_text.clone())?;
    Ok((engine, schema_text))
}


/// `schema` None = no validation (legacy); Some(path) = validate, and an unreadable or invalid schema is an error.
pub fn load_engine_with_schema(path: &Path, schema: Option<&Path>) -> Result<Engine, String> {
    let schema_text = schema
        .map(|p| std::fs::read_to_string(&p).map_err(|e| format!("cannot read schema {}: {e}", p.display())))
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

/// The engine that DECIDES for a tenant: its own when the active version carries rules (step 4), else the boot one.
enum EngineRef<'a> { Boot(&'a Engine), Tenant(Arc<Engine>) }
impl std::ops::Deref for EngineRef<'_> {
    type Target = Engine;
    fn deref(&self) -> &Engine { match self { Self::Boot(e) => e, Self::Tenant(e) => e } }
}
fn engine_for<'a>(c: &'a Core, tenant: Option<&str>) -> (EngineRef<'a>, &'static str) {
    if let Some(t) = tenant {
        if let Some(e) = c.engines.read().unwrap().get(t).cloned() { return (EngineRef::Tenant(e), "tenant"); }
    }
    (EngineRef::Boot(&c.engine), "boot")
}

pub async fn list(State(c): State<Arc<Core>>, headers: HeaderMap, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let (engine, source) = engine_for(&c, q.get("tenant").map(String::as_str));
    let rules = engine.catalog();
    let mut sets: Vec<(String, usize)> = Vec::new();
    for r in rules { match sets.iter_mut().find(|(n, _)| *n == r.set) { Some(s) => s.1 += 1, None => sets.push((r.set.clone(), 1)) } }
    (StatusCode::OK, Json(json!({
        "engine": {"rules": rules.len(), "sets": sets.len(), "schema": engine.validated(), "source": source},
        "sets": sets.iter().map(|(n, k)| json!({"name": n, "rules": k})).collect::<Vec<_>>(),
        "rules": rules,
    })))
}

/// Candidate rules for validation or simulation (policy-studio step 4): named sets plus template links. Limits keep a
/// dry-run cheap; the engine's own checks (set names, rule ids, duplicate ids, slots) apply on top.
#[derive(serde::Deserialize)]
pub struct CandidatePolicies {
    pub sets: Vec<PolicySource>,
    #[serde(default)]
    pub links: Vec<PolicyLink>,
}

fn check_candidate(cand: &CandidatePolicies) -> Result<(), String> {
    if cand.sets.is_empty() || cand.sets.len() > 32 { return Err("1 to 32 policy sets expected".into()); }
    if cand.sets.iter().any(|s| s.text.len() > 256 * 1024) { return Err("a policy set may not exceed 256 KiB".into()); }
    if cand.links.len() > 512 { return Err("at most 512 template links".into()); }
    Ok(())
}

/// Builds a throwaway engine for candidate rules, validated with the SAME schema the core loaded (None = parse only,
/// the answer then carries schema:false so the caller knows no schema check happened).
fn candidate_engine(c: &Core, cand: &CandidatePolicies) -> Result<Engine, String> {
    check_candidate(cand)?;
    match &c.policy_schema {
        Some(schema) => Engine::from_sets_with_schema_and_links(&cand.sets, schema, &cand.links).map_err(|e| e.to_string()),
        None => Engine::from_sets_and_links(&cand.sets, &cand.links).map_err(|e| e.to_string()),
    }
}

/// Dry-run validation of candidate rules against the loaded schema (policy-studio step 4). Admin token.
/// 200 = the candidate builds (answer: its catalogue, so a console can preview ids and summaries before committing);
/// 400 = refused, the error names the rule. Nothing is swapped: the loaded engine is untouched either way.
pub async fn validate(State(c): State<Arc<Core>>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    c.bus_emit("policy.admin", json!({"operation":"validate", "authorized":crate::bus_wiring::is_admin(&c, &headers)}), None);
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let cand: CandidatePolicies = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid validation request: {e}")}))),
    };
    match candidate_engine(&c, &cand) {
        Ok(e) => {
            let rules = e.catalog();
            let mut sets: Vec<(String, usize)> = Vec::new();
            for r in rules { match sets.iter_mut().find(|(n, _)| *n == r.set) { Some(s) => s.1 += 1, None => sets.push((r.set.clone(), 1)) } }
            (StatusCode::OK, Json(json!({
                "valid": true, "schema": e.validated(),
                "engine": {"rules": rules.len(), "sets": sets.len()},
                "sets": sets.iter().map(|(n, k)| json!({"name": n, "rules": k})).collect::<Vec<_>>(),
                "rules": rules,
            })))
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"valid": false, "error": e}))),
    }
}

/// Simulates a request against the loaded rules: the decision it would get and why (policy-studio step 3). Admin token.
/// With a `policies` field ({sets, links}) the simulation runs on those CANDIDATE rules instead (step 4: check a branch's
/// rules before applying them); a candidate that does not build is a 400 naming the rule.
pub async fn simulate(State(c): State<Arc<Core>>, headers: HeaderMap, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    c.bus_emit("policy.admin", json!({"operation":"simulate", "authorized":crate::bus_wiring::is_admin(&c, &headers)}), None);
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    #[derive(serde::Deserialize)]
    struct SimulateBody {
        #[serde(flatten)]
        req: DecisionRequest,
        policies: Option<CandidatePolicies>,
        /// Step 4: simulate on the rules that DECIDE for this tenant (its applied version, else the boot set).
        tenant: Option<String>,
    }
    let body: SimulateBody = match serde_json::from_value(body) {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid simulation request: {e}")}))),
    };
    let candidate = match &body.policies {
        Some(cand) => match candidate_engine(&c, cand) {
            Ok(e) => Some(e),
            Err(e) => return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("candidate rules refused: {e}")}))),
        },
        None => None,
    };
    let (tenant_engine, source) = engine_for(&c, body.tenant.as_deref());
    let (engine, source) = match &candidate { Some(e) => (e, "candidate"), None => (&*tenant_engine, source) };
    match engine.simulate(&body.req) {
        Ok(s) => {
            let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
            v["engine_of"] = json!(source); // which rules answered: candidate, the tenant's applied version, or the boot set
            (StatusCode::OK, Json(v))
        }
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
        c.policy_schema = Some(DEMO_SCHEMA.into());
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
        assert_eq!(v["engine"], json!({"rules": 20, "sets": 1, "schema": true, "source": "boot"}));
        let rules = v["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 20);
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
        assert_eq!(e.catalog().len(), 20);
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

    // ---- Candidate validation and simulation (policy-studio step 4) ----

    async fn post(c: &Arc<Core>, uri: &str, tok: Option<&str>, body: Value) -> (StatusCode, Value) {
        let mut r = Request::builder().method("POST").uri(uri).header("content-type", "application/json");
        if let Some(t) = tok { r = r.header("x-core-admin-token", t); }
        let resp = crate::app(c.clone()).oneshot(r.body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let st = resp.status();
        (st, serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap_or(Value::Null))
    }

    const CANDIDATE: &str = r#"@id("night-freeze") @pillar("sod")
forbid(principal, action == Action::"approve", resource) when { context has hour && context.hour >= 20 };
@id("delegated-approve") @pillar("human")
permit(principal == ?principal, action == Action::"approve", resource);
"#;

    #[tokio::test]
    async fn validate_checks_candidate_rules_against_the_loaded_schema() {
        let c = demo_core();
        let body = || json!({"sets": [{"set": "sod", "text": CANDIDATE}], "links": []});
        // Admin token required.
        assert_eq!(post(&c, "/v1/policies/validate", None, body()).await.0, StatusCode::UNAUTHORIZED);
        // A valid candidate: 200, schema-checked, catalogue returned (ids and summaries for the console preview).
        let (st, v) = post(&c, "/v1/policies/validate", Some(TOKEN), body()).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        assert_eq!((v["valid"].as_bool(), v["schema"].as_bool()), (Some(true), Some(true)));
        let rules = v["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 2);
        assert!(rules.iter().any(|r| r["id"] == "sod/night-freeze" && r["summary"].is_string()));
        // A rule the schema rejects: 400 naming the rule; the loaded engine is untouched.
        let bad = json!({"sets": [{"set": "sod", "text": "@id(\"typo\") permit(principal, action == Action::\"aprove\", resource);"}], "links": []});
        let (st, v) = post(&c, "/v1/policies/validate", Some(TOKEN), bad).await;
        assert_eq!((st, v["valid"].as_bool()), (StatusCode::BAD_REQUEST, Some(false)));
        assert!(v["error"].as_str().unwrap().contains("sod/typo"), "{v}");
        let (_, cat) = get(&c, Some(TOKEN)).await;
        assert_eq!(cat["engine"]["rules"], json!(20), "validation never swaps the loaded rules");
    }

    #[tokio::test]
    async fn validate_checks_candidate_links_and_refuses_absurd_input() {
        let c = demo_core();
        // A link naming an unknown template is refused, naming the link.
        let bad = json!({"sets": [{"set": "sod", "text": CANDIDATE}],
            "links": [{"id": "x1", "template": "sod/no-such-template", "values": {"principal": "User::\"demo-alice\""}}]});
        let (st, v) = post(&c, "/v1/policies/validate", Some(TOKEN), bad).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("x1"), "{v}");
        // A valid link passes; the catalogue shows it as a link of its template.
        let ok = json!({"sets": [{"set": "sod", "text": CANDIDATE}],
            "links": [{"id": "delegate:demo-bob", "template": "sod/delegated-approve", "values": {"principal": "User::\"demo-bob\""}}]});
        let (st, v) = post(&c, "/v1/policies/validate", Some(TOKEN), ok).await;
        assert_eq!(st, StatusCode::OK, "{v}");
        let link = v["rules"].as_array().unwrap().iter().find(|r| r["id"] == "delegate:demo-bob").unwrap().clone();
        assert_eq!((link["kind"].as_str(), link["template"].as_str()), (Some("link"), Some("sod/delegated-approve")));
        // Absurd sizes are refused cheaply.
        assert_eq!(post(&c, "/v1/policies/validate", Some(TOKEN), json!({"sets": [], "links": []})).await.0, StatusCode::BAD_REQUEST);
        let huge = json!({"sets": [{"set": "sod", "text": "p".repeat(300 * 1024)}], "links": []});
        assert_eq!(post(&c, "/v1/policies/validate", Some(TOKEN), huge).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn simulate_can_run_on_candidate_rules_instead_of_the_loaded_ones() {
        let c = demo_core();
        // Without `policies`: the loaded demo rules answer (alice allowed by demo-alice-approves).
        let base = json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\""});
        let (st, v) = post(&c, "/v1/policies/simulate", Some(TOKEN), base.clone()).await;
        assert_eq!((st, v["allow"].as_bool()), (StatusCode::OK, Some(true)));
        // With candidate rules: the candidate answers instead (only the linked grant allows demo-bob, alice is denied).
        let mut with_cand = base.clone();
        with_cand["policies"] = json!({"sets": [{"set": "sod", "text": CANDIDATE}],
            "links": [{"id": "delegate:demo-bob", "template": "sod/delegated-approve", "values": {"principal": "User::\"demo-bob\""}}]});
        let (st, v) = post(&c, "/v1/policies/simulate", Some(TOKEN), with_cand.clone()).await;
        assert_eq!((st, v["allow"].as_bool()), (StatusCode::OK, Some(false)));
        assert_eq!(v["explanation"].as_str().unwrap(), "DENIED: no rule permits this request. Templates never apply until linked per person, role or resource (sod/delegated-approve not linked).");
        with_cand["principal"] = json!("User::\"demo-bob\"");
        let (st, v) = post(&c, "/v1/policies/simulate", Some(TOKEN), with_cand).await;
        assert_eq!((st, v["allow"].as_bool(), v["reasons"][0].as_str()), (StatusCode::OK, Some(true), Some("delegate:demo-bob")));
        // A broken candidate is a 400 naming the rule, and never a fake simulation.
        let mut broken = base.clone();
        broken["policies"] = json!({"sets": [{"set": "sod", "text": "@id(\"typo\") permit(principal, action == Action::\"aprove\", resource);"}], "links": []});
        let (st, v) = post(&c, "/v1/policies/simulate", Some(TOKEN), broken).await;
        assert_eq!(st, StatusCode::BAD_REQUEST);
        assert!(v["error"].as_str().unwrap().contains("sod/typo"), "{v}");
    }
}
