//! Bus core tested alone (no network): in-process transport, same JSON wire format as NATS.
use async_trait::async_trait;
use iam_bus::*;
use iam_plugin_runtime::PluginRuntime;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

/// Transport that returns a hand-made reply, to test the core's identity check.
struct Raw(Vec<u8>);
#[async_trait]
impl Transport for Raw { async fn request(&self, _s: &str, _b: Vec<u8>, _t: Duration) -> Result<Vec<u8>, TransportError> { Ok(self.0.clone()) } }

fn cat() -> Catalogue { Catalogue::new().declare("auth.check", Mode::Control).declare("user.created", Mode::Notify).declare("profile.get", Mode::Query) }
fn sub(id: &str, kind: &str, mandatory: bool, group: Option<&str>) -> Subscription { Subscription { subscriber: id.into(), kind: kind.into(), mandatory, group: group.map(Into::into) } }
fn env(id: &str, kind: &str, p: serde_json::Value) -> Envelope { Envelope::new(id, kind, p) }

#[tokio::test]
async fn catalogue_and_registry_rules() {
    let d = Dispatcher::new(cat(), Arc::new(InProcTransport::new()), Duration::from_millis(100));
    assert!(matches!(d.notify(&env("1", "nope", json!({}))).await, Err(BusError::UnknownKind(_))));
    assert!(matches!(d.call(&env("1", "user.created", json!({})), None).await, Err(BusError::WrongMode { .. })));
    assert!(d.subscribe(sub("a", "user.created", true, None)).is_err(), "mandatory on a notify kind");
    assert!(d.subscribe(sub("a", "auth.check", false, Some("g"))).is_err(), "group on a control kind");
    assert!(d.subscribe(sub("a b", "auth.check", false, None)).is_err(), "id becomes a subject token");
    assert!(d.subscribe(sub("a.b", "auth.check", false, None)).is_err());
    d.subscribe(sub("a", "auth.check", false, None)).unwrap();
    assert!(d.subscribe(sub("a", "auth.check", false, None)).is_err(), "duplicate");
}

#[tokio::test]
async fn no_subscriber_means_allow_and_reserved_tenant_is_carried() {
    let d = Dispatcher::new(cat(), Arc::new(InProcTransport::new()), Duration::from_millis(100));
    assert_eq!(d.call(&env("1", "auth.check", json!({})), None).await.unwrap().verdict, Verdict::Allow);
    let mut e = env("2", "auth.check", json!({}));
    e.tenant = Some("acme".into());
    let back: Envelope = serde_json::from_slice(&serde_json::to_vec(&e).unwrap()).unwrap();
    assert_eq!(back.tenant.as_deref(), Some("acme"));
}

#[tokio::test]
async fn forged_from_or_wrong_id_is_treated_as_silence() {
    for bytes in [br#"{"from":"evil","id":"1","verdict":"allow"}"#.to_vec(), br#"{"from":"a","id":"OTHER","verdict":"allow"}"#.to_vec(), b"not json".to_vec()] {
        let d = Dispatcher::new(cat(), Arc::new(Raw(bytes)), Duration::from_millis(100));
        d.subscribe(sub("a", "auth.check", true, None)).unwrap();
        let r = d.call(&env("1", "auth.check", json!({})), None).await.unwrap();
        assert_eq!(r.verdict, Verdict::Deny, "mandatory + invalid reply = refusal");
        assert!(matches!(r.outcomes[0].status, SubStatus::Invalid(_)));
        let d2 = Dispatcher::new(cat(), Arc::new(Raw(br#"{"from":"evil","id":"1","verdict":"deny"}"#.to_vec())), Duration::from_millis(100));
        d2.subscribe(sub("a", "auth.check", false, None)).unwrap();
        assert_eq!(d2.call(&env("1", "auth.check", json!({})), None).await.unwrap().verdict, Verdict::Allow, "optional + invalid reply = ignored");
    }
}

#[tokio::test]
async fn wasm_subscriber_through_the_bus() {
    let wasm = wat::parse_str(include_str!("../../../../plugins/examples/deny-off-hours.wat")).unwrap();
    let t = Arc::new(InProcTransport::new());
    t.register("offhours", Arc::new(WasmHandler::new(Arc::new(PluginRuntime::new(100_000).unwrap()), wasm)));
    let d = Dispatcher::new(cat(), t.clone(), Duration::from_millis(500));
    d.subscribe(sub("offhours", "auth.check", true, None)).unwrap();
    let call = |h: i64, s: bool| { let d = &d; async move { d.call(&env("1", "auth.check", json!({"hour": h, "sensitive": s})), None).await.unwrap().verdict } };
    assert_eq!(call(23, true).await, Verdict::Deny);
    assert_eq!(call(10, true).await, Verdict::Allow);
    assert_eq!(call(23, false).await, Verdict::Allow);
    // same verdicts as the existing runtime test; a bad payload makes the plugin silent, so a mandatory control refuses
    let bad = d.call(&env("2", "auth.check", json!({"nope": 1})), None).await.unwrap();
    assert_eq!(bad.verdict, Verdict::Deny);
}

#[tokio::test]
async fn trapping_wasm_is_isolated_from_other_subscribers() {
    let looping = wat::parse_str(r#"(module (func (export "decide") (param i32 i32) (result i32) (loop $l (br $l)) (i32.const 0)))"#).unwrap();
    let ok = wat::parse_str(r#"(module (func (export "decide") (param i32 i32) (result i32) (i32.const 0)))"#).unwrap();
    let rt = Arc::new(PluginRuntime::new(50_000).unwrap());
    let t = Arc::new(InProcTransport::new());
    t.register("loop", Arc::new(WasmHandler::new(rt.clone(), looping)));
    t.register("fine", Arc::new(WasmHandler::new(rt, ok)));
    let d = Dispatcher::new(cat(), t, Duration::from_millis(500));
    d.subscribe(sub("loop", "auth.check", false, None)).unwrap();
    d.subscribe(sub("fine", "auth.check", true, None)).unwrap();
    let r = d.call(&env("1", "auth.check", json!({"hour": 1, "sensitive": false})), None).await.unwrap();
    assert_eq!(r.verdict, Verdict::Allow);
    assert!(matches!(r.outcomes.iter().find(|o| o.subscriber == "loop").unwrap().status, SubStatus::Silent(_)));
}
