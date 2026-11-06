//! Step 2 end-to-end: the core's plugin-host protocol over HTTP + a fake plugin answering over NATS.
//! Needs the `nats-server` binary: path in NATS_SERVER_BIN or `nats-server` on PATH. Skipped (loudly) when absent
//! unless IAM_REQUIRE_NATS=1, which CI-like runs must set.
use iam_bus::{nats, Envelope, Handler, HandlerResult, Verdict};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

const NATS_PORT: u16 = 14451;
const CORE_PORT: u16 = 18451;
const TOKEN: &str = "step2-test-token";

struct Proc(Child);
impl Drop for Proc { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

fn start_nats() -> Option<Proc> {
    let bin = std::env::var("NATS_SERVER_BIN").unwrap_or_else(|_| "nats-server".into());
    let conf = format!("{}/../../../conf/nats-local.conf", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&conf).unwrap()
        .replace("127.0.0.1:4222", &format!("127.0.0.1:{NATS_PORT}"))
        .replace("/tmp/iam-nats-js", &format!("/tmp/iam-nats-js-{NATS_PORT}"));
    let tmp = format!("/tmp/iam-core-step2-{NATS_PORT}.conf");
    std::fs::write(&tmp, text).unwrap();
    let child = match Command::new(&bin).args(["-c", &tmp]).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(c) => c,
        Err(e) => { assert!(std::env::var("IAM_REQUIRE_NATS").is_err(), "nats-server required: {e}"); eprintln!("SKIPPED: no nats-server ({e})"); return None; }
    };
    for _ in 0..50 { if std::net::TcpStream::connect(("127.0.0.1", NATS_PORT)).is_ok() { return Some(Proc(child)) } std::thread::sleep(Duration::from_millis(100)); }
    panic!("nats-server did not start");
}

fn start_core() -> Proc {
    let policy = format!("{}/../../../policies/demo.cedar", env!("CARGO_MANIFEST_DIR"));
    let child = Command::new(env!("CARGO_BIN_EXE_iam-core"))
        .env("IAM_CORE_NATS_URL", format!("127.0.0.1:{NATS_PORT}"))
        .env("IAM_CORE_NATS_PASSWORD", "core-dev")
        .env("IAM_CORE_ADMIN_TOKEN", TOKEN)
        .env("IAM_CORE_ADDR", format!("127.0.0.1:{CORE_PORT}"))
        .env("IAM_POLICY_FILE", policy)
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("spawn iam-core");
    for _ in 0..50 {
        if http(CORE_PORT, "GET", "/health", None, None).0 == 200 { return Proc(child) }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("iam-core did not start");
}

/// Minimal HTTP/1.1 client (no extra dependency): one request per connection.
fn http(port: u16, method: &str, path: &str, token: Option<&str>, body: Option<Value>) -> (u16, Value) {
    let body_s = body.map(|b| b.to_string()).unwrap_or_default();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body_s.len());
    if let Some(t) = token { req += &format!("x-core-admin-token: {t}\r\n"); }
    req.push_str("\r\n");
    req.push_str(&body_s);
    let mut s = match std::net::TcpStream::connect(("127.0.0.1", port)) { Ok(s) => s, Err(_) => return (0, Value::Null) };
    s.write_all(req.as_bytes()).unwrap();
    let mut buf = String::new();
    s.read_to_string(&mut buf).unwrap();
    let status: u16 = buf.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let json = buf.split("\r\n\r\n").nth(1).unwrap_or("null");
    (status, serde_json::from_str(json).unwrap_or(Value::Null))
}

fn register(plugin: &str, subs: Value, emits: Value, declares: Value) -> (u16, Value) {
    http(CORE_PORT, "POST", "/v1/bus/plugins/register", Some(TOKEN), Some(json!({"plugin": plugin, "subscriptions": subs, "emits": emits, "declare_kinds": declares})))
}
fn emit(source: &str, kind: &str, payload: Value) -> (u16, Value) {
    http(CORE_PORT, "POST", "/v1/bus/emit", Some(TOKEN), Some(json!({"source": source, "kind": kind, "tenant": "acme-demo", "payload": payload})))
}

/// Fake plugin: records every envelope it sees and answers allow + a data echo (control/query calls).
#[derive(Default)]
struct Echo { seen: std::sync::Mutex<Vec<Envelope>> }
#[async_trait::async_trait]
impl Handler for Echo {
    async fn handle(&self, env: &Envelope) -> Option<HandlerResult> {
        self.seen.lock().unwrap().push(env.clone());
        Some(HandlerResult { verdict: Some(Verdict::Allow), data: Some(json!({"saw_source": env.source, "saw_kind": env.kind})) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plugin_host_protocol_end_to_end() {
    let Some(_nats) = start_nats() else { return };
    let _core = start_core();

    // auth + validation
    assert_eq!(http(CORE_PORT, "POST", "/v1/bus/emit", None, Some(json!({"source":"api","kind":"notify.send"}))).0, 401);
    assert_eq!(http(CORE_PORT, "POST", "/v1/bus/plugins/register", None, Some(json!({"plugin":"x"}))).0, 401);
    assert_eq!(register("core-evil", json!([]), json!([]), json!([])).0, 400, "reserved id");
    assert_eq!(register("notify-log", json!([{"kind":"notify.send"}]), json!([]), json!([])).0, 400, "unknown kind before declaration");

    // the API host declares the platform kind, then registers the plugin's delivery
    assert_eq!(register("api", json!([]), json!([]), json!([{"name":"notify.send","mode":"notify"}])).0, 200);
    assert_eq!(register("notify-log", json!([{"kind":"notify.send"}]), json!([]), json!([])).0, 200);

    // a fake plugin answers control calls AND pulls its durable event deliveries, as the restricted api-host user
    let (client, _errs) = nats::connect(&format!("127.0.0.1:{NATS_PORT}"), "api-host", "api-host-dev", Some("_INBOX.api-host")).await.unwrap();
    let echo = std::sync::Arc::new(Echo::default());
    let _serve = nats::serve(client.clone(), "notify-log", echo.clone()).await.unwrap();
    let _events = nats::serve_events(client, "notify-log", echo.clone()).await.unwrap();

    let (st, r) = emit("api", "notify.send", json!({"to": "alice@example.com", "template": "hi"}));
    assert_eq!((st, r["mode"].as_str()), (200, Some("notify")), "{r}");
    let out = &r["outcomes"][0];
    assert_eq!((out["id"].as_str(), out["status"].as_str()), (Some("notify-log"), Some("queued")), "{r}");
    // the delivery itself is asynchronous (at-least-once): the plugin receives the stored event shortly after
    let mut saw = None;
    for _ in 0..50 {
        if let Some(e) = echo.seen.lock().unwrap().iter().find(|e| e.kind == "notify.send") { saw = Some(e.clone()); break }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(saw.expect("the queued event is delivered").source.as_deref(), Some("api"), "the core stamps the source");

    // the observer records the exchange with its source
    let (st, recs) = http(CORE_PORT, "GET", "/v1/bus/records?limit=5", Some(TOKEN), None);
    assert_eq!(st, 200);
    let last = recs["records"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["kind"].as_str(), last["source"].as_str()), (Some("notify.send"), Some("api")), "{last}");

    // emission grants are enforced
    assert_eq!(emit("plugin:notify-log", "notify.send", json!({})).0, 403, "no grant");
    assert_eq!(emit("api", "activation.applied", json!({})).0, 403, "core-owned kind");
    assert_eq!(register("notify-log", json!([{"kind":"notify.send"}]), json!(["plg.notify-log.ping"]), json!([{"name":"plg.notify-log.ping","mode":"notify"}])).0, 200);
    assert_eq!(emit("plugin:notify-log", "plg.notify-log.ping", json!({})).0, 200, "granted custom kind");
    assert_eq!(register("notify-log", json!([]), json!([]), json!([{"name":"other.ns.x","mode":"notify"}])).0, 400, "declare outside namespace");

    // Control through the same protocol: fail closed when a mandatory subscriber is silent (D3)
    assert_eq!(register("api", json!([]), json!([]), json!([{"name":"plg.e2e.check","mode":"control"}])).0, 200);
    assert_eq!(register("notify-log", json!([{"kind":"plg.e2e.check","mandatory":true}]), json!([]), json!([])).0, 200);
    let (st, r) = emit("api", "plg.e2e.check", json!({}));
    assert_eq!((st, r["verdict"].as_str()), (200, Some("allow")), "{r}");
    assert_eq!(register("ghost", json!([{"kind":"plg.e2e.check","mandatory":true}]), json!([]), json!([])).0, 200);
    let (st, r) = emit("api", "plg.e2e.check", json!({}));
    assert_eq!((st, r["verdict"].as_str()), (200, Some("deny")), "silent mandatory ghost must deny: {r}");
    assert!(r["reason"].as_str().unwrap().contains("ghost"));

    // unregister cuts deliveries
    assert_eq!(http(CORE_PORT, "POST", "/v1/bus/plugins/unregister", Some(TOKEN), Some(json!({"plugin":"ghost"}))).0, 200);
    let (_, r) = emit("api", "plg.e2e.check", json!({}));
    assert_eq!(r["verdict"], "allow", "{r}");
    let (_, list) = http(CORE_PORT, "GET", "/v1/bus/plugins", Some(TOKEN), None);
    assert!(list["plugins"]["notify-log"].is_object() && list["plugins"]["ghost"].is_null(), "{list}");
}
