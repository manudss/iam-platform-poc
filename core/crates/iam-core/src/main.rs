use axum::{Json, Router, extract::State, http::StatusCode, routing::{get, post}};
use iam_decision::{DecisionRequest, DecisionResponse, Engine};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn app(engine: Arc<Engine>) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status":"ok","service":"iam-core"})) }))
        .route("/v1/decide", post(decide))
        .with_state(engine)
}

async fn decide(State(e): State<Arc<Engine>>, Json(req): Json<DecisionRequest>)
    -> Result<Json<DecisionResponse>, (StatusCode, Json<Value>)> {
    e.decide(&req).map(Json).map_err(|err| (StatusCode::BAD_REQUEST, Json(json!({"error": err.to_string()}))))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let path = std::env::var("IAM_POLICY_FILE").unwrap_or_else(|_| "../policies/demo.cedar".into());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let engine = Arc::new(Engine::new(&text).expect("invalid policies"));
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
        let engine = Arc::new(Engine::new(include_str!("../../../../policies/demo.cedar")).unwrap());
        let r = app(engine).oneshot(Request::post("/v1/decide")
            .header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap();
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
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
