use crate::BusError;
use std::collections::HashMap;
use std::sync::RwLock;

/// How an event kind behaves.
/// Notify: delivered, no answer used. Control: every subscriber may answer allow/deny (blocking call).
/// Query: subscribers answer with data that the core merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode { Notify, Control, Query }

/// Known event kinds and their modes. Interior mutability: step 2 lets the control plane declare new kinds at
/// runtime (a plugin only inside its own `plg.<id>.*` namespace) while the bus is running.
#[derive(Default, Debug)]
pub struct Catalogue { map: RwLock<HashMap<String, Mode>> }

impl Clone for Catalogue {
    fn clone(&self) -> Self { Self { map: RwLock::new(self.map.read().unwrap().clone()) } }
}

impl Catalogue {
    pub fn new() -> Self { Self::default() }
    pub fn declare(self, kind: &str, mode: Mode) -> Self { self.map.write().unwrap().insert(kind.to_string(), mode); self }
    /// Runtime declaration: re-declaring the same kind with the same mode is a no-op; changing a mode is refused.
    pub fn try_declare(&self, kind: &str, mode: Mode) -> Result<(), String> {
        let mut m = self.map.write().unwrap();
        match m.get(kind) {
            Some(&existing) if existing != mode => Err(format!("kind '{kind}' already declared with another mode")),
            Some(_) => Ok(()),
            None => { m.insert(kind.to_string(), mode); Ok(()) }
        }
    }
    pub fn mode(&self, kind: &str) -> Result<Mode, BusError> {
        self.map.read().unwrap().get(kind).copied().ok_or_else(|| BusError::UnknownKind(kind.to_string()))
    }
    pub fn expect(&self, kind: &str, expected: Mode) -> Result<(), BusError> {
        if self.mode(kind)? == expected { Ok(()) } else { Err(BusError::WrongMode { kind: kind.to_string(), expected }) }
    }
}
