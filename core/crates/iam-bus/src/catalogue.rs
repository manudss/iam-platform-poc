use crate::BusError;
use std::collections::HashMap;

/// How an event kind behaves.
/// Notify: delivered, no answer used. Control: every subscriber may answer allow/deny (blocking call).
/// Query: subscribers answer with data that the core merges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode { Notify, Control, Query }

#[derive(Default, Debug, Clone)]
pub struct Catalogue(HashMap<String, Mode>);

impl Catalogue {
    pub fn new() -> Self { Self::default() }
    pub fn declare(mut self, kind: &str, mode: Mode) -> Self { self.0.insert(kind.to_string(), mode); self }
    pub fn mode(&self, kind: &str) -> Result<Mode, BusError> {
        self.0.get(kind).copied().ok_or_else(|| BusError::UnknownKind(kind.to_string()))
    }
    pub fn expect(&self, kind: &str, expected: Mode) -> Result<(), BusError> {
        if self.mode(kind)? == expected { Ok(()) } else { Err(BusError::WrongMode { kind: kind.to_string(), expected }) }
    }
}
