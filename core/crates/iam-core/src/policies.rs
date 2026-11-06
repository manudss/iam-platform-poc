//! Read-only rule catalogue (policy-studio step 1) and the loader for one or several rule files.
//!   GET /v1/policies  (admin token) -> { engine: {rules, sets}, sets: [{name, rules}], rules: [RuleInfo...] }
//! Nothing here changes a decision: the catalogue is a view of what the engine loaded at startup.
//! Loading: IAM_POLICY_FILE is a file (one set named "default") or a directory (every `*.cedar` file is one set, named after the file).
use crate::Core;
use axum::{Json, extract::State, http::{HeaderMap, StatusCode}};
use iam_decision::{Engine, PolicySource};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

/// A file gives one "default" set; a directory gives one set per `*.cedar` file (sorted by name, so the order never depends on the disk).
pub fn load_engine(path: &Path) -> Result<Engine, String> {
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
        Engine::from_sets(&sets).map_err(|e| e.to_string())
    } else {
        let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        Engine::new(&text).map_err(|e| e.to_string())
    }
}

pub async fn list(State(c): State<Arc<Core>>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    if !crate::bus_wiring::is_admin(&c, &headers) { return (StatusCode::UNAUTHORIZED, Json(json!({"error": "admin token required"}))); }
    let rules = c.engine.catalog();
    let mut sets: Vec<(String, usize)> = Vec::new();
    for r in rules { match sets.iter_mut().find(|(n, _)| *n == r.set) { Some(s) => s.1 += 1, None => sets.push((r.set.clone(), 1)) } }
    (StatusCode::OK, Json(json!({
        "engine": {"rules": rules.len(), "sets": sets.len()},
        "sets": sets.iter().map(|(n, k)| json!({"name": n, "rules": k})).collect::<Vec<_>>(),
        "rules": rules,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use iam_idp::Idp;
    use tower::ServiceExt;

    const TOKEN: &str = "test-admin-token";
    fn demo_core() -> Arc<Core> {
        let mut c = Core::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), None, Idp::demo("http://idp.test"));
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
        assert_eq!(v["engine"], json!({"rules": 6, "sets": 1}));
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

    #[tokio::test]
    async fn a_decision_names_the_rule_that_decided() {
        let c = demo_core();
        let body = json!({"principal":"User::\"alice\"","action":"Action::\"approve\"","resource":"Request::\"r1\"","context":{"sod_conflict":true}});
        let r = crate::app(c.clone()).oneshot(Request::post("/v1/decide").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
        let v: Value = serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(v["allow"], false);
        assert_eq!(v["reasons"], json!(["sod-blocks-approve"]));
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
