//! Decision engine: Cedar policies evaluated in-process.
//! Semantics (verified against Cedar docs): any satisfied `forbid` => Deny;
//! otherwise Allow if a `permit` is satisfied; otherwise Deny.
//! A policy that errors is SKIPPED by Cedar, so we deny any decision with errors.
use cedar_policy::{
    Authorizer, Context, Decision, Entities, EntityUid, PolicySet, Request,
};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum DecisionError {
    #[error("invalid input: {0}")]
    Input(String),
    #[error("policy parse error: {0}")]
    Policy(String),
}

#[derive(Debug, Deserialize)]
pub struct DecisionRequest {
    pub principal: String, // e.g. User::"alice"
    pub action: String,    // e.g. Action::"read"
    pub resource: String,  // e.g. Resource::"payroll"
    #[serde(default)]
    pub context: serde_json::Value,
    #[serde(default)]
    pub entities: serde_json::Value, // Cedar JSON entities array
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DecisionResponse {
    pub allow: bool,
    pub reasons: Vec<String>,
    pub errors: Vec<String>,
}

pub struct Engine {
    policies: PolicySet,
    authorizer: Authorizer,
}

impl Engine {
    pub fn new(policy_text: &str) -> Result<Self, DecisionError> {
        let policies = PolicySet::from_str(policy_text)
            .map_err(|e| DecisionError::Policy(e.to_string()))?;
        Ok(Self { policies, authorizer: Authorizer::new() })
    }

    pub fn decide(&self, req: &DecisionRequest) -> Result<DecisionResponse, DecisionError> {
        let uid = |s: &str| EntityUid::from_str(s).map_err(|e| DecisionError::Input(e.to_string()));
        let ctx = if req.context.is_null() {
            Context::empty()
        } else {
            Context::from_json_value(req.context.clone(), None)
                .map_err(|e| DecisionError::Input(e.to_string()))?
        };
        let ents = if req.entities.is_null() {
            Entities::empty()
        } else {
            Entities::from_json_value(req.entities.clone(), None)
                .map_err(|e| DecisionError::Input(e.to_string()))?
        };
        let request = Request::new(uid(&req.principal)?, uid(&req.action)?, uid(&req.resource)?, ctx, None)
            .map_err(|e| DecisionError::Input(e.to_string()))?;
        let resp = self.authorizer.is_authorized(&request, &self.policies, &ents);
        let errors: Vec<String> = resp.diagnostics().errors().map(|e| e.to_string()).collect();
        let reasons: Vec<String> = resp.diagnostics().reason().map(|p| p.to_string()).collect();
        // Fail closed: an errored policy is skipped by Cedar, so never trust Allow with errors.
        let allow = resp.decision() == Decision::Allow && errors.is_empty();
        Ok(DecisionResponse { allow, reasons, errors })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const POLICY: &str = r#"
permit(principal == User::"alice", action == Action::"read", resource == Resource::"payroll");
forbid(principal, action, resource) when { context.after_hours == true };
"#;

    fn req(after_hours: bool) -> DecisionRequest {
        DecisionRequest {
            principal: r#"User::"alice""#.into(),
            action: r#"Action::"read""#.into(),
            resource: r#"Resource::"payroll""#.into(),
            context: json!({ "after_hours": after_hours }),
            entities: json!([]),
        }
    }

    #[test]
    fn permit_when_in_hours() {
        let e = Engine::new(POLICY).unwrap();
        assert!(e.decide(&req(false)).unwrap().allow);
    }

    #[test]
    fn forbid_overrides_permit() {
        let e = Engine::new(POLICY).unwrap();
        assert!(!e.decide(&req(true)).unwrap().allow);
    }

    #[test]
    fn unknown_principal_denied() {
        let e = Engine::new(POLICY).unwrap();
        let mut r = req(false);
        r.principal = r#"User::"mallory""#.into();
        assert!(!e.decide(&r).unwrap().allow);
    }

    #[test]
    fn policy_error_fails_closed() {
        // `context.missing` errors at evaluation; Cedar skips the policy, we must still deny.
        let e = Engine::new(r#"permit(principal, action, resource) when { context.missing == 1 };
permit(principal, action, resource);"#).unwrap();
        let r = e.decide(&req(false)).unwrap();
        assert!(!r.errors.is_empty());
        assert!(!r.allow);
    }
}
