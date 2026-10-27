use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, post}};
use iam_decision::{DecisionRequest, DecisionResponse, Engine};
use serde_json::{Value, json};
use iam_plugin_runtime::{PluginRuntime, Verdict};
use std::sync::Arc;

/// Shared state: Cedar engine plus an optional blocking WASM plugin (wasm bytes).
pub struct Core { pub engine: Engine, pub plugin: Option<(PluginRuntime, Vec<u8>)> }

pub fn app(engine: Arc<Core>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok","service":"iam-core"})) }))
        .route("/v1/decide", post(decide))
        .with_state(engine)
}

async fn decide(State(c): State<Arc<Core>>, Json(req): Json<DecisionRequest>)
    -> Result<Json<DecisionResponse>, (StatusCode, Json<Value>)> {
    let mut resp = c.engine.decide(&req)
        .map_err(|err| (StatusCode::BAD_REQUEST, Json(json!({"error": err.to_string()}))))?;
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
    Ok(Json(resp))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let path = std::env::var("IAM_POLICY_FILE").unwrap_or_else(|_| "../policies/demo.cedar".into());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let engine = Engine::new(&text).expect("invalid policies");
    let plugin = std::env::var("IAM_PLUGIN_WAT").ok().map(|p| {
        let wat = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("cannot read plugin {p}: {e}"));
        (PluginRuntime::new(100_000).unwrap(), wat::parse_str(wat).expect("invalid plugin"))
    });
    let engine = Arc::new(Core { engine, plugin });
    let addr = std::env::var("IAM_CORE_ADDR").unwrap_or_else(|_| "127.0.0.1:8081".into());
    let l = tokio::net::TcpListener::bind(&addr).await.unwrap();
    tracing::info!("iam-core listening on {addr}");
    axum::serve(l, app(engine)).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn call(body: Value) -> Value {
        let engine = Arc::new(Core { engine: Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(), plugin: None });
        let r = app(engine).oneshot(Request::post("/v1/decide")
            .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }

    #[tokio::test]
    async fn plugin_denies_sensitive_off_hours() {
        let wasm = wat::parse_str(include_str!("../../../../plugins/examples/deny-off-hours.wat")).unwrap();
        let core = Arc::new(Core { engine: Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap(),
            plugin: Some((PluginRuntime::new(100_000).unwrap(), wasm)) });
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
