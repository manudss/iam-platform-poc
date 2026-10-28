//! Signed plugin packages for the blocking WASM hook.
//! A package is: manifest.json (name, version, abi, wasm_sha256, publisher), manifest.sig (Ed25519 over the EXACT manifest bytes,
//! base64url) and plugin.wasm. The core loads it only if the signature verifies under a TRUSTED public key, the ABI is the one
//! this core implements and the wasm hash equals the signed one. Anything else is refused (the core does not start).
//! Not covered: key management/rotation/revocation, a signing CLI, per-tenant enablement, supply-chain provenance.
use iam_idp::detached;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Manifest { pub name: String, pub version: String, pub abi: String, pub wasm_sha256: String, pub publisher: String }

pub const ABI: &str = "decide-v0";

pub fn load(manifest: &[u8], sig_b64: &str, wasm: &[u8], trusted_keys: &[String]) -> Result<Manifest, String> {
    if trusted_keys.is_empty() { return Err("no trusted publisher keys configured".into()); }
    if !trusted_keys.iter().any(|k| detached::verify(k.trim(), manifest, sig_b64.trim())) {
        return Err("manifest signature is not valid for any trusted key".into());
    }
    let m: Manifest = serde_json::from_slice(manifest).map_err(|e| format!("bad manifest: {e}"))?;
    if m.abi != ABI { return Err(format!("unsupported abi {}", m.abi)); }
    if !m.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || m.name.is_empty() { return Err("invalid plugin name".into()); }
    if detached::sha256_hex(wasm) != m.wasm_sha256 { return Err("wasm hash does not match the signed manifest".into()); }
    if !wasm.starts_with(b"\0asm") { return Err("not a wasm binary".into()); }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iam_plugin_runtime::{PluginRuntime, Verdict};

    const SEED: [u8; 32] = [7; 32]; // demo/test key only
    fn wasm() -> Vec<u8> { wat::parse_str(include_str!("../../../../plugins/examples/deny-off-hours.wat")).unwrap() }
    fn manifest(w: &[u8], abi: &str) -> Vec<u8> {
        serde_json::json!({"name":"deny-off-hours","version":"0.1.0","abi":abi,"wasm_sha256":detached::sha256_hex(w),"publisher":"demo-publisher"}).to_string().into_bytes()
    }
    fn trusted() -> Vec<String> { vec![detached::public_key(SEED)] }

    #[test]
    fn valid_package_loads_and_runs() {
        let w = wasm(); let m = manifest(&w, ABI); let sig = detached::sign(SEED, &m);
        let loaded = load(&m, &sig, &w, &trusted()).unwrap();
        assert_eq!(loaded.name, "deny-off-hours");
        assert_eq!(PluginRuntime::new(100_000).unwrap().run(&w, 23, true).unwrap(), Verdict::Deny);
    }
    #[test]
    fn tampered_wasm_is_refused() {
        let w = wasm(); let m = manifest(&w, ABI); let sig = detached::sign(SEED, &m);
        let mut bad = w.clone(); bad.push(0);
        assert!(load(&m, &sig, &bad, &trusted()).unwrap_err().contains("hash"));
    }
    #[test]
    fn tampered_manifest_is_refused() {
        let w = wasm(); let m = manifest(&w, ABI); let sig = detached::sign(SEED, &m);
        let other = String::from_utf8(m).unwrap().replace("0.1.0", "9.9.9").into_bytes();
        assert!(load(&other, &sig, &w, &trusted()).unwrap_err().contains("signature"));
    }
    #[test]
    fn untrusted_or_missing_keys_are_refused() {
        let w = wasm(); let m = manifest(&w, ABI); let sig = detached::sign(SEED, &m);
        assert!(load(&m, &sig, &w, &[detached::public_key([9; 32])]).is_err());
        assert!(load(&m, &sig, &w, &[]).unwrap_err().contains("no trusted"));
        assert!(load(&m, "not-a-signature", &w, &trusted()).is_err());
    }
    #[test]
    fn signed_but_wrong_abi_is_refused() {
        let w = wasm(); let m = manifest(&w, "decide-v9"); let sig = detached::sign(SEED, &m);
        assert!(load(&m, &sig, &w, &trusted()).unwrap_err().contains("abi"));
    }
}
