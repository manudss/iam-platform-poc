//! gRPC `iam.decision.v1.Decision/Decide` (tonic). Same decision path as HTTP `/v1/decide` (see `decide_value`).
//! Plaintext, intended for loopback / a private network only in this POC (no TLS, no auth on this call: do not expose it).
use crate::{Core, decide_value};
use serde_json::{Value, json};
use std::sync::Arc;
use tonic::{Request, Response, Status};

pub mod pb { tonic::include_proto!("iam.decision.v1"); }
use pb::decision_server::{Decision, DecisionServer};
use pb::{DecideRequest, DecideResponse};

pub struct Svc(Arc<Core>);
pub fn service(c: Arc<Core>) -> DecisionServer<Svc> { DecisionServer::new(Svc(c)) }

pub(crate) fn to_json(r: &DecideRequest) -> Result<Value, Status> {
    let context: Value = if r.context_json.trim().is_empty() { json!({}) } else {
        serde_json::from_str(&r.context_json).map_err(|e| Status::invalid_argument(format!("context_json: {e}")))?
    };
    let mut v = json!({"principal": r.principal, "action": r.action, "resource": r.resource, "context": context});
    if !r.tenant.is_empty() { v["tenant"] = json!(r.tenant); }
    Ok(v)
}

pub(crate) fn from_json(v: &Value) -> DecideResponse {
    let strs = |k: &str| v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default();
    DecideResponse {
        allow: v.get("allow").and_then(|x| x.as_bool()).unwrap_or(false),
        reasons: strs("reasons"), errors: strs("errors"),
        commit: v.pointer("/version/commit").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        activation: v.pointer("/version/seq").and_then(|x| x.as_u64()).unwrap_or(0),
    }
}

#[tonic::async_trait]
impl Decision for Svc {
    async fn decide(&self, req: Request<DecideRequest>) -> Result<Response<DecideResponse>, Status> {
        let raw = to_json(req.get_ref())?;
        match decide_value(&self.0, raw) {
            Ok(v) => Ok(Response::new(from_json(&v))),
            Err((_, e)) => Err(Status::invalid_argument(e.get("error").and_then(|m| m.as_str()).unwrap_or("bad request").to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pb::decision_client::DecisionClient;
    use iam_decision::Engine;
    use iam_idp::Idp;

    fn core() -> Arc<Core> {
        let policy = include_str!("../../../../policies/demo.cedar").to_string();
        Arc::new(Core::new(Engine::new(&policy).unwrap(), None, Idp::demo("http://127.0.0.1:1")))
    }

    #[tokio::test]
    async fn grpc_decide_over_a_real_socket_matches_http_semantics() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let svc = service(core());
        tokio::spawn(async move { tonic::transport::Server::builder().add_service(svc).serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(l)).await.unwrap() });
        let mut c = DecisionClient::connect(format!("http://{addr}")).await.unwrap();
        // no tenant: caller-supplied context is used (demo mode); an alice approver with no SoD is allowed by the demo policy
        let ok = c.decide(DecideRequest { principal: "User::\"demo-alice\"".into(), action: "Action::\"approve\"".into(), resource: "Request::\"r1\"".into(),
            context_json: "{\"roles\":[\"payment-approver\"],\"sod_conflict\":false}".into(), activation: 0, tenant: String::new() }).await.unwrap().into_inner();
        assert!(ok.allow, "{ok:?}");
        let no = c.decide(DecideRequest { principal: "User::\"demo-alice\"".into(), action: "Action::\"approve\"".into(), resource: "Request::\"r1\"".into(),
            context_json: "{\"roles\":[],\"sod_conflict\":false}".into(), activation: 0, tenant: String::new() }).await.unwrap().into_inner();
        assert!(!no.allow);
        // tenant without an active version: fail closed
        let t = c.decide(DecideRequest { principal: "User::\"demo-alice\"".into(), action: "Action::\"approve\"".into(), resource: "Request::\"r1\"".into(),
            context_json: "{\"roles\":[\"payment-approver\"]}".into(), activation: 0, tenant: "acme-demo".into() }).await.unwrap().into_inner();
        assert!(!t.allow); assert_eq!(t.reasons, vec!["no-active-version".to_string()]);
        // malformed context_json is an INVALID_ARGUMENT status
        let bad = c.decide(DecideRequest { context_json: "{nope".into(), ..Default::default() }).await.unwrap_err();
        assert_eq!(bad.code(), tonic::Code::InvalidArgument);
    }
}
