//! Blocking plugin runtime (v0 contract).
//! A plugin is a WASM module exporting `memory`, `alloc(len)->ptr` is NOT required in v0:
//! v0 passes a flat i32 context and expects an i32 verdict from `decide(hour: i32, sensitive: i32) -> i32`
//! (0 = allow, 1 = deny). Limits: fuel (CPU budget) and no imports (no host access at all).
//! This is a deliberately tiny first contract to prove isolation and limits;
//! the richer JSON-over-linear-memory contract is described in docs/plugin-contract-v0.md.
use anyhow::{Result, anyhow};
use wasmtime::{Config, Engine, Module, Store, Instance};

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict { Allow, Deny }

pub struct PluginRuntime { engine: Engine, fuel: u64 }

impl PluginRuntime {
    pub fn new(fuel: u64) -> Result<Self> {
        let mut cfg = Config::new();
        cfg.consume_fuel(true);
        Ok(Self { engine: Engine::new(&cfg)?, fuel })
    }

    /// Run a plugin given as WAT text or WASM bytes.
    pub fn run(&self, wasm: &[u8], hour: i32, sensitive: bool) -> Result<Verdict> {
        let module = Module::new(&self.engine, wasm)?;
        if module.imports().len() > 0 {
            return Err(anyhow!("plugin declares imports; not allowed in v0"));
        }
        let mut store = Store::new(&self.engine, ());
        store.set_fuel(self.fuel)?;
        let inst = Instance::new(&mut store, &module, &[])?;
        let f = inst.get_typed_func::<(i32, i32), i32>(&mut store, "decide")?;
        // Any trap (out of fuel, etc.) is an error: callers must fail closed.
        let r = f.call(&mut store, (hour, sensitive as i32))?;
        Ok(if r == 0 { Verdict::Allow } else { Verdict::Deny })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OFF_HOURS: &str = include_str!("../../../../plugins/examples/deny-off-hours.wat");

    fn rt() -> PluginRuntime { PluginRuntime::new(100_000).unwrap() }

    #[test]
    fn denies_sensitive_off_hours() {
        let wasm = wat::parse_str(OFF_HOURS).unwrap();
        assert_eq!(rt().run(&wasm, 23, true).unwrap(), Verdict::Deny);
        assert_eq!(rt().run(&wasm, 3, true).unwrap(), Verdict::Deny);
    }

    #[test]
    fn allows_in_hours_or_non_sensitive() {
        let wasm = wat::parse_str(OFF_HOURS).unwrap();
        assert_eq!(rt().run(&wasm, 10, true).unwrap(), Verdict::Allow);
        assert_eq!(rt().run(&wasm, 23, false).unwrap(), Verdict::Allow);
    }

    #[test]
    fn infinite_loop_is_stopped_by_fuel() {
        let wasm = wat::parse_str(r#"(module (func (export "decide") (param i32 i32) (result i32) (loop $l (br $l)) (i32.const 0)))"#).unwrap();
        assert!(rt().run(&wasm, 10, true).is_err());
    }

    #[test]
    fn imports_rejected() {
        let wasm = wat::parse_str(r#"(module (import "env" "x" (func)) (func (export "decide") (param i32 i32) (result i32) (i32.const 0)))"#).unwrap();
        assert!(rt().run(&wasm, 10, true).is_err());
    }
}
