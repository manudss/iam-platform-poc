// Compiles proto/decision.proto with protox (pure Rust, no protoc needed) and generates the tonic server/client.
fn main() {
    let proto = "../../../proto/decision.proto";
    println!("cargo:rerun-if-changed={proto}");
    let fds = protox::compile([proto], ["../../../proto"]).expect("proto compile");
    tonic_build::configure().build_client(true).compile_fds(fds).expect("tonic codegen");
}
