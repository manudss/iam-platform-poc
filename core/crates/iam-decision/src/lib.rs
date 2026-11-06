//! Decision engine: Cedar policies evaluated in-process.
//! Semantics (verified against Cedar docs): any satisfied `forbid` => Deny;
//! otherwise Allow if a `permit` is satisfied; otherwise Deny.
//! A policy that errors is SKIPPED by Cedar, so we deny any decision with errors.
//!
//! Rule sets and names (policy-studio step 1): the engine is built from one or more named SETS of Cedar text. The sets are merged into ONE
//! Cedar policy set (Cedar evaluates a single set), so a `forbid` in any set overrides a `permit` in any other set. Every rule gets a readable
//! id: its `@id("...")` annotation (prefixed by the set name unless the set is "default"), else Cedar's generated `policyN`. That id is what
//! `reasons` and error messages carry, so the decision audit names the rule. `catalog()` lists the rules for the read-only console screen.
use cedar_policy::{
    Authorizer, Context, Decision, Effect, Entities, EntityUid, Policy, PolicyId, PolicySet, Request, Schema, Template,
    ValidationMode, Validator,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum DecisionError {
    #[error("invalid input: {0}")]
    Input(String),
    #[error("policy parse error: {0}")]
    Policy(String),
    #[error("invalid Cedar schema: {0}")]
    Schema(String),
    #[error("rules refused by the schema: {0}")]
    Validation(String),
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

/// One named set of Cedar rules (one file, later one Dolt row group). The name "default" is not shown in rule ids.
#[derive(Debug, Clone)]
pub struct PolicySource {
    pub set: String,
    pub text: String,
}

/// A rule as the catalogue shows it. Read-only view: nothing here changes a decision.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuleInfo {
    /// Id carried by `reasons` and the audit: `<set>/<name>`, or just `<name>` in the "default" set.
    pub id: String,
    pub set: String,
    pub name: String,
    /// `policy` (static rule) or `template` (rule with ?principal / ?resource slots, linked per person, role or organisation).
    pub kind: &'static str,
    pub effect: String,
    pub description: Option<String>,
    /// Free grouping label from the `@pillar` annotation (human access, SoD, MCP, gateway...).
    pub pillar: Option<String>,
    /// Plain-language reading of the scope, generated from the rule itself (never from the description).
    pub summary: String,
    pub conditions: usize,
    pub annotations: BTreeMap<String, String>,
    pub text: String,
}

pub struct Engine {
    policies: PolicySet,
    authorizer: Authorizer,
    catalog: Vec<RuleInfo>,
    /// Whether the rules were validated against a Cedar schema at load (policy-studio step 2).
    validated: bool,
}

fn valid_set_name(s: &str) -> bool { !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') }
fn valid_rule_name(s: &str) -> bool { !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':')) }

fn entity_text(v: &serde_json::Value) -> String {
    match (v.get("type").and_then(|t| t.as_str()), v.get("id").and_then(|t| t.as_str())) {
        (Some(t), Some(i)) => format!("{t}::\"{i}\""),
        _ => v.get("slot").and_then(|x| x.as_str()).map(str::to_string).unwrap_or_else(|| "?".into()),
    }
}
fn list_text(v: &serde_json::Value) -> String {
    v.get("entities").and_then(|e| e.as_array()).map(|a| a.iter().map(entity_text).collect::<Vec<_>>().join(" or ")).unwrap_or_default()
}
/// "any principal" / "principal User::\"alice\"" / "a principal in Role::\"x\"" ... from the JSON form of the scope.
fn scope_text(v: &serde_json::Value, noun: &str) -> String {
    let op = v.get("op").and_then(|o| o.as_str()).unwrap_or("All");
    match op {
        "All" => format!("any {noun}"),
        "==" => format!("{noun} {}", entity_text(v.get("entity").unwrap_or(&serde_json::Value::Null))),
        "in" if v.get("entities").is_some() => format!("{noun} in {}", list_text(v)),
        "in" => format!("{noun} in {}", entity_text(v.get("entity").unwrap_or(&serde_json::Value::Null))),
        "is" => {
            let t = v.get("entity_type").and_then(|t| t.as_str()).unwrap_or("?");
            match v.get("in") { Some(i) => format!("{noun} of type {t} in {}", entity_text(i.get("entity").unwrap_or(i))), None => format!("{noun} of type {t}") }
        }
        other => format!("{noun} ({other})"),
    }
}
fn summarize(effect: Effect, json: &serde_json::Value, conditions: usize) -> String {
    let verb = if effect == Effect::Permit { "Permits" } else { "Forbids" };
    let c = match conditions { 0 => String::new(), 1 => ", under 1 condition".into(), n => format!(", under {n} conditions") };
    let (p, a, r) = (json.get("principal"), json.get("action"), json.get("resource"));
    let nul = serde_json::Value::Null;
    format!("{verb} {} to do {} on {}{c}.", scope_text(p.unwrap_or(&nul), "principal"), scope_text(a.unwrap_or(&nul), "action"), scope_text(r.unwrap_or(&nul), "resource"))
}

impl Engine {
    /// A single set named "default" (the historical single policy file).
    pub fn new(policy_text: &str) -> Result<Self, DecisionError> {
        Self::from_sets(&[PolicySource { set: "default".into(), text: policy_text.into() }])
    }

    /// A single set, validated against the given Cedar schema (cedarschema syntax) before it can decide anything.
    pub fn new_with_schema(policy_text: &str, schema: &str) -> Result<Self, DecisionError> {
        Self::build(&[PolicySource { set: "default".into(), text: policy_text.into() }], Some(schema))
    }

    /// Several named sets, validated against the given Cedar schema.
    pub fn from_sets_with_schema(sets: &[PolicySource], schema: &str) -> Result<Self, DecisionError> {
        Self::build(sets, Some(schema))
    }

    /// Several named sets merged into one Cedar set. A duplicate rule id (same set and name, or the same prefixed id) is refused: ids must be unique
    /// because the audit identifies a rule by it. An empty list of sets is refused (never an empty, permissive-looking engine).
    pub fn from_sets(sets: &[PolicySource]) -> Result<Self, DecisionError> {
        Self::build(sets, None)
    }

    fn build(sets: &[PolicySource], schema: Option<&str>) -> Result<Self, DecisionError> {
        if sets.is_empty() { return Err(DecisionError::Policy("at least one policy set is required".into())); }
        let mut merged = PolicySet::new();
        let mut catalog = Vec::new();
        let mut seen_sets = std::collections::BTreeSet::new();
        for src in sets {
            if !valid_set_name(&src.set) { return Err(DecisionError::Policy(format!("invalid policy set name {:?}: lowercase letters, digits, - and _ (max 64)", src.set))); }
            if !seen_sets.insert(src.set.clone()) { return Err(DecisionError::Policy(format!("duplicate policy set {:?}", src.set))); }
            let parsed = PolicySet::from_str(&src.text).map_err(|e| DecisionError::Policy(format!("set {}: {e}", src.set)))?;
            let full = |name: &str| if src.set == "default" { name.to_string() } else { format!("{}/{name}", src.set) };
            let name_of = |own: &PolicyId, ann: Option<&str>| -> Result<String, DecisionError> {
                match ann {
                    Some(n) if valid_rule_name(n) => Ok(n.to_string()),
                    Some(n) => Err(DecisionError::Policy(format!("set {}: invalid @id {:?} (letters, digits, - _ . : ; max 80)", src.set, n))),
                    None => Ok(own.to_string()),
                }
            };
            for p in parsed.policies() {
                let name = name_of(p.id(), p.annotation("id"))?;
                let id = full(&name);
                let renamed: Policy = p.new_id(PolicyId::new(&id));
                let json = renamed.to_json().map_err(|e| DecisionError::Policy(e.to_string()))?;
                let n = json.get("conditions").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
                catalog.push(RuleInfo {
                    id: id.clone(), set: src.set.clone(), name, kind: "policy", effect: effect_name(renamed.effect()),
                    description: renamed.annotation("description").map(str::to_string), pillar: renamed.annotation("pillar").map(str::to_string),
                    summary: summarize(renamed.effect(), &json, n), conditions: n,
                    annotations: renamed.annotations().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                    text: renamed.to_cedar().unwrap_or_default(),
                });
                merged.add(renamed).map_err(|e| DecisionError::Policy(format!("rule id {id} is used twice: {e}")))?;
            }
            for t in parsed.templates() {
                let name = name_of(t.id(), t.annotation("id"))?;
                let id = full(&name);
                let renamed: Template = t.new_id(PolicyId::new(&id));
                let json = renamed.to_json().map_err(|e| DecisionError::Policy(e.to_string()))?;
                let n = json.get("conditions").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
                catalog.push(RuleInfo {
                    id: id.clone(), set: src.set.clone(), name, kind: "template", effect: effect_name(renamed.effect()),
                    description: renamed.annotation("description").map(str::to_string), pillar: renamed.annotation("pillar").map(str::to_string),
                    summary: summarize(renamed.effect(), &json, n), conditions: n,
                    annotations: renamed.annotations().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                    text: renamed.to_cedar(),
                });
                merged.add_template(renamed).map_err(|e| DecisionError::Policy(format!("rule id {id} is used twice: {e}")))?;
            }
        }
        catalog.sort_by(|a, b| (&a.set, &a.id).cmp(&(&b.set, &b.id)));
        let validated = match schema {
            None => false,
            Some(src) => {
                let (schema, _warnings) = Schema::from_cedarschema_str(src).map_err(|e| DecisionError::Schema(e.to_string()))?;
                let result = Validator::new(schema).validate(&merged, ValidationMode::Strict);
                if !result.validation_passed() {
                    // The merged set holds the renamed rules, so each error names the readable rule id the audit also uses.
                    let details = result.validation_errors().map(|e| format!("[{}] {e}", e.policy_id())).collect::<Vec<_>>().join("; ");
                    return Err(DecisionError::Validation(details));
                }
                true
            }
        };
        Ok(Self { policies: merged, authorizer: Authorizer::new(), catalog, validated })
    }

    /// Read-only list of the loaded rules, sorted by set then id.
    pub fn catalog(&self) -> &[RuleInfo] { &self.catalog }

    /// True when the rules were validated against a Cedar schema at load.
    pub fn validated(&self) -> bool { self.validated }

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

fn effect_name(e: Effect) -> String { if e == Effect::Permit { "permit".into() } else { "forbid".into() } }

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

    // ---- Rule sets, names, composition (verified behaviour the plan relies on) ----

    fn src(set: &str, text: &str) -> PolicySource { PolicySource { set: set.into(), text: text.into() } }
    fn dreq(principal: &str, action: &str, ctx: serde_json::Value, entities: serde_json::Value) -> DecisionRequest {
        DecisionRequest { principal: principal.into(), action: action.into(), resource: r#"Resource::"r1""#.into(), context: ctx, entities }
    }

    #[test]
    fn id_annotation_names_the_rule_in_reasons() {
        let e = Engine::new(r#"
@id("alice-reads-payroll") @description("Alice may read payroll") @pillar("human")
permit(principal == User::"alice", action == Action::"read", resource);
permit(principal == User::"bob", action == Action::"read", resource);
"#).unwrap();
        let r = e.decide(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        assert!(r.allow);
        assert_eq!(r.reasons, vec!["alice-reads-payroll"]);
        // A rule without @id keeps Cedar's generated name (policyN): still unique, but not readable.
        let r = e.decide(&dreq(r#"User::"bob""#, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        assert_eq!(r.reasons.len(), 1);
        assert!(r.reasons[0].starts_with("policy"), "{:?}", r.reasons);
        let c = e.catalog();
        assert_eq!(c.len(), 2);
        let a = c.iter().find(|x| x.id == "alice-reads-payroll").unwrap();
        assert_eq!((a.set.as_str(), a.kind, a.effect.as_str()), ("default", "policy", "permit"));
        assert_eq!(a.description.as_deref(), Some("Alice may read payroll"));
        assert_eq!(a.pillar.as_deref(), Some("human"));
        assert_eq!(a.summary, r#"Permits principal User::"alice" to do action Action::"read" on any resource."#);
        assert!(a.text.contains("permit(principal == User::\"alice\""), "{}", a.text);
    }

    #[test]
    fn errors_name_the_rule_too() {
        let e = Engine::new(r#"@id("needs-missing-attr") permit(principal, action, resource) when { context.missing == 1 };"#).unwrap();
        let r = e.decide(&dreq(r#"User::"a""#, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        assert!(!r.allow);
        assert!(r.errors.iter().any(|m| m.contains("needs-missing-attr")), "{:?}", r.errors);
    }

    #[test]
    fn several_sets_are_one_decision_and_forbid_wins_across_sets() {
        let e = Engine::from_sets(&[
            src("sso", r#"@id("wiki-for-employees") permit(principal, action == Action::"open", resource) when { context.roles.contains("employee") };"#),
            src("sod", r#"@id("no-open-with-conflict") forbid(principal, action, resource) when { context.sod_conflict == true };"#),
        ]).unwrap();
        let open = |conflict: bool| e.decide(&dreq(r#"User::"alice""#, r#"Action::"open""#, json!({"roles":["employee"], "sod_conflict": conflict}), json!([]))).unwrap();
        let ok = open(false);
        assert!(ok.allow);
        assert_eq!(ok.reasons, vec!["sso/wiki-for-employees"]);
        let no = open(true);
        assert!(!no.allow);
        // Cedar reports only the forbid that decided: the audit names the rule of the OTHER set.
        assert_eq!(no.reasons, vec!["sod/no-open-with-conflict"]);
        assert_eq!(e.catalog().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["sod/no-open-with-conflict", "sso/wiki-for-employees"]);
    }

    #[test]
    fn same_name_in_two_sets_is_fine_but_twice_in_one_set_is_refused() {
        let ok = Engine::from_sets(&[src("a", r#"@id("r") permit(principal, action, resource);"#), src("b", r#"@id("r") forbid(principal, action, resource);"#)]).unwrap();
        assert_eq!(ok.catalog().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a/r", "b/r"]);
        assert!(Engine::new(r#"@id("r") permit(principal, action, resource); @id("r") forbid(principal, action, resource);"#).is_err());
        assert!(Engine::from_sets(&[src("a", ""), src("a", "")]).is_err());
        assert!(Engine::from_sets(&[src("Bad Name", "")]).is_err());
        assert!(Engine::from_sets(&[]).is_err());
        assert!(Engine::new(r#"@id("has space") permit(principal, action, resource);"#).is_err());
    }

    #[test]
    fn rules_read_the_person_through_entity_attributes_and_roles() {
        // One static rule gives different answers per person: the attribute and the role come from the entity data of the request.
        let e = Engine::new(r#"
@id("same-department-reads") permit(principal, action == Action::"read", resource) when { principal.department == resource.department };
@id("auditors-read-all") permit(principal in Role::"auditor", action == Action::"read", resource);
"#).unwrap();
        let ents = json!([
            {"uid":{"type":"User","id":"alice"},"attrs":{"department":"hr"},"parents":[]},
            {"uid":{"type":"User","id":"bob"},"attrs":{"department":"sales"},"parents":[{"type":"Role","id":"auditor"}]},
            {"uid":{"type":"User","id":"carol"},"attrs":{"department":"sales"},"parents":[]},
            {"uid":{"type":"Resource","id":"r1"},"attrs":{"department":"hr"},"parents":[]},
            {"uid":{"type":"Role","id":"auditor"},"attrs":{},"parents":[]}
        ]);
        let who = |u: &str| e.decide(&dreq(&format!(r#"User::"{u}""#), r#"Action::"read""#, json!({}), ents.clone())).unwrap();
        assert_eq!((who("alice").allow, who("alice").reasons), (true, vec!["same-department-reads".to_string()]));
        assert_eq!((who("bob").allow, who("bob").reasons), (true, vec!["auditors-read-all".to_string()]));
        assert!(!who("carol").allow);
    }


    // ---- Schema validation (policy-studio step 2) ----

    /// A small schema covering two actions, an optional and a required context attribute.
    const SCHEMA: &str = r#"
entity Role;
entity User in [Role] = { department?: String };
entity Resource = { department?: String };
entity Request;
action "read" appliesTo {
  principal: [User],
  resource: [Resource],
  context: { after_hours?: Bool, roles?: Set<String> }
};
action "approve" appliesTo {
  principal: [User],
  resource: [Request],
  context: { amount: Long, frozen?: Bool }
};
"#;

    #[test]
    fn schema_accepts_rules_that_match_it() {
        let e = Engine::new_with_schema(r#"
@id("alice-reads") permit(principal == User::"alice", action == Action::"read", resource) when { context has after_hours && context.after_hours == false };
@id("small-approvals") permit(principal, action == Action::"approve", resource) when { context.amount < 1000 };
"#,
            SCHEMA).unwrap();
        assert!(e.validated());
        // Decisions still work exactly as without a schema.
        let r = e.decide(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({"after_hours": false}), json!([]))).unwrap();
        assert!(r.allow);
        assert_eq!(r.reasons, vec!["alice-reads"]);
    }

    #[test]
    fn schema_refuses_a_typo_action_and_names_the_rule() {
        let err = Engine::new_with_schema(r#"@id("alice-approves") permit(principal, action == Action::"aprove", resource);"#, SCHEMA).err().unwrap();
        let msg = err.to_string();
        assert!(msg.contains("alice-approves"), "{msg}"); // the readable rule id, not policyN
        assert!(msg.contains("aprove"), "{msg}");
    }

    #[test]
    fn schema_refuses_an_unknown_entity_type_and_attribute() {
        let err = Engine::new_with_schema(r#"permit(principal == Employee::"alice", action == Action::"read", resource);"#, SCHEMA).err().unwrap();
        assert!(err.to_string().contains("Employee"), "{err}");
        let err = Engine::new_with_schema(r#"permit(principal, action == Action::"read", resource) when { context.roles.contains(42) };"#, SCHEMA).err().unwrap();
        assert!(err.to_string().contains("roles"), "{err}");
    }

    #[test]
    fn schema_refuses_reading_an_optional_attribute_without_a_guard() {
        // Strict validation: an optional context attribute must be guarded with `has` (an unguarded read
        // would error at evaluation time and the rule would be silently skipped - exactly what the schema catches).
        let err = Engine::new_with_schema(r#"@id("unguarded") permit(principal, action == Action::"read", resource) when { context.after_hours == true };"#, SCHEMA).err().unwrap();
        assert!(err.to_string().contains("unguarded"), "{err}");
        // The guarded form passes.
        Engine::new_with_schema(r#"permit(principal, action == Action::"read", resource) when { context has after_hours && context.after_hours == true };"#, SCHEMA).unwrap();
    }

    #[test]
    fn schema_refuses_a_condition_of_the_wrong_type() {
        let err = Engine::new_with_schema(r#"permit(principal, action == Action::"approve", resource) when { context.amount == "a lot" };"#, SCHEMA).err().unwrap();
        assert!(err.to_string().contains("not compatible"), "{err}");
    }

    #[test]
    fn schema_validates_templates_and_across_sets() {
        // A template with a slot of the wrong entity type is refused; valid sets still merge and validate together.
        let ok = Engine::from_sets_with_schema(&[
            src("sso", r#"@id("dept-read") permit(principal == ?principal, action == Action::"read", resource) when { principal has department && resource has department && principal.department == resource.department };"#),
            src("sod", r#"@id("frozen") forbid(principal, action == Action::"approve", resource) when { context has frozen && context.frozen == true };"#),
        ], SCHEMA).unwrap();
        assert!(ok.validated());
        assert_eq!(ok.catalog().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["sod/frozen", "sso/dept-read"]);
        let err = Engine::from_sets_with_schema(&[
            src("sso", r#"permit(principal == ?principal, action == Action::"read", resource);"#),
            src("bad", r#"@id("typo") permit(principal, action == Action::"reed", resource);"#),
        ], SCHEMA).err().unwrap();
        assert!(err.to_string().contains("bad/typo"), "{err}");
    }

    #[test]
    fn an_invalid_schema_is_refused_and_no_schema_keeps_the_old_behaviour() {
        assert!(Engine::new("permit(principal, action, resource);").unwrap().validated() == false);
        let err = Engine::new_with_schema("permit(principal, action, resource);", "entity User in [").err().unwrap();
        assert!(matches!(err, DecisionError::Schema(_)), "{err}");
        // A rule the schema does not know still parses fine without a schema.
        Engine::new(r#"permit(principal == Employee::"x", action == Action::"anything", resource);"#).unwrap();
    }

    #[test]
    fn a_template_linked_per_person_role_or_resource_group() {
        // Cedar mechanism, used directly: a template with slots is instantiated ("linked") once per beneficiary. The engine does not link yet
        // (policy-studio step 4 will store the links in Dolt); this test pins down what Cedar itself does so the plan rests on a verified fact.
        let mut set = PolicySet::from_str(r#"
@id("delegated-read") permit(principal == ?principal, action == Action::"read", resource == ?resource);
@id("role-read") permit(principal in ?principal, action == Action::"read", resource);
forbid(principal, action, resource) when { context.frozen == true };
"#).unwrap();
        // Verified: Cedar does NOT take the policy id from @id when parsing text (ids stay policy0, policy1); the annotation is just data,
        // which is why Engine::from_sets renames each rule from its @id itself.
        let by_ann = |name: &str| set.templates().find(|t| t.annotation("id") == Some(name)).map(|t| t.id().clone()).unwrap();
        assert_eq!(set.templates().count(), 2);
        assert!(set.templates().all(|t| t.id().to_string().starts_with("policy")));
        let (delegated, role) = (by_ann("delegated-read"), by_ann("role-read"));
        let uid = |s: &str| EntityUid::from_str(s).unwrap();
        let slot_p = cedar_policy::SlotId::principal();
        let slot_r = cedar_policy::SlotId::resource();
        set.link(delegated.clone(), PolicyId::new("delegated-read:alice:r1"), [(slot_p.clone(), uid(r#"User::"alice""#)), (slot_r.clone(), uid(r#"Resource::"r1""#))].into()).unwrap();
        set.link(role.clone(), PolicyId::new("role-read:auditor"), [(slot_p.clone(), uid(r#"Role::"auditor""#))].into()).unwrap();
        // linking the same id twice, or a missing slot value, is refused
        assert!(set.link(role.clone(), PolicyId::new("role-read:auditor"), [(slot_p.clone(), uid(r#"Role::"x""#))].into()).is_err());
        assert!(set.link(delegated, PolicyId::new("bad"), [(slot_p, uid(r#"User::"z""#))].into()).is_err());
        let ents = Entities::from_json_value(json!([
            {"uid":{"type":"User","id":"bob"},"attrs":{},"parents":[{"type":"Role","id":"auditor"}]},
            {"uid":{"type":"Role","id":"auditor"},"attrs":{},"parents":[]}
        ]), None).unwrap();
        let ask = |who: &str, res: &str, frozen: bool| {
            let r = Request::new(uid(who), uid(r#"Action::"read""#), uid(res), Context::from_json_value(json!({"frozen": frozen}), None).unwrap(), None).unwrap();
            let resp = Authorizer::new().is_authorized(&r, &set, &ents);
            (resp.decision() == Decision::Allow, resp.diagnostics().reason().map(|p| p.to_string()).collect::<Vec<_>>())
        };
        assert_eq!(ask(r#"User::"alice""#, r#"Resource::"r1""#, false), (true, vec!["delegated-read:alice:r1".to_string()]));
        assert!(!ask(r#"User::"alice""#, r#"Resource::"r2""#, false).0, "the link only covers r1");
        assert!(!ask(r#"User::"carol""#, r#"Resource::"r1""#, false).0, "the link only covers alice");
        assert_eq!(ask(r#"User::"bob""#, r#"Resource::"r9""#, false), (true, vec!["role-read:auditor".to_string()]));
        // forbid beats the per-person grant too
        assert!(!ask(r#"User::"alice""#, r#"Resource::"r1""#, true).0);
    }
}
