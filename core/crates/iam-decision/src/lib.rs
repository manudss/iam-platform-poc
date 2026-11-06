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
    Authorizer, Context, Decision, Effect, Entities, EntityUid, Policy, PolicyId, PolicySet, Request, Schema, SlotId, Template,
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

/// A rule that errored during a simulated evaluation (Cedar skips an errored rule; the engine fails closed on it).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SimError {
    pub id: String,
    pub error: String,
}

/// The answer of a simulated request (policy-studio step 3): the same decision the engine would give, plus WHY -
/// every permit and forbid that matched (not only the ones that decided), the rules that errored, the templates
/// (never applicable until linked), and a plain-language explanation. Read-only: nothing here changes a decision.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Simulation {
    pub allow: bool,
    /// The deciding rules (same as a real decision): the satisfied permits on an allow, the satisfied forbids on a deny.
    pub reasons: Vec<String>,
    pub errors: Vec<String>,
    /// Every static permit the request satisfies (even the ones a forbid overruled).
    pub matched_permits: Vec<String>,
    /// Every static forbid the request satisfies (any one of them decides a deny).
    pub matched_forbids: Vec<String>,
    /// Rules skipped because they errored on this request.
    pub errored_rules: Vec<SimError>,
    /// Templates in the set: they never apply until linked (per person, role or resource - step 4 stores the links).
    pub templates: Vec<String>,
    /// One sentence: why the request is allowed or denied.
    pub explanation: String,
}

/// One named set of Cedar rules (one file, later one Dolt row group). The name "default" is not shown in rule ids.
#[derive(Debug, Clone, Deserialize)]
pub struct PolicySource {
    pub set: String,
    pub text: String,
}

/// One template link (policy-studio step 4): instantiates a template once per beneficiary (a person, a role or an
/// organisation), exactly like `PolicySet::link`. The link id is what `reasons` and the audit carry for the grant,
/// e.g. `sso/delegate-read:demo-bob`. Links are data (stored in Dolt, applied with the rest of a version).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyLink {
    /// Id of the instantiated rule. Must be unique across rules, templates and other links.
    pub id: String,
    /// Catalogue id of the template to instantiate (e.g. `sso/delegate-read`).
    pub template: String,
    /// Slot values: `principal` and/or `resource`, as entity uid text (`User::"alice"`, `Role::"auditor"`, ...).
    pub values: BTreeMap<String, String>,
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
    /// For a `link`: the catalogue id of the template it instantiates. Absent on rules and templates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
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
        Self::build(&[PolicySource { set: "default".into(), text: policy_text.into() }], Some(schema), &[])
    }

    /// Several named sets, validated against the given Cedar schema.
    pub fn from_sets_with_schema(sets: &[PolicySource], schema: &str) -> Result<Self, DecisionError> {
        Self::build(sets, Some(schema), &[])
    }

    /// Several named sets merged into one Cedar set. A duplicate rule id (same set and name, or the same prefixed id) is refused: ids must be unique
    /// because the audit identifies a rule by it. An empty list of sets is refused (never an empty, permissive-looking engine).
    pub fn from_sets(sets: &[PolicySource]) -> Result<Self, DecisionError> {
        Self::build(sets, None, &[])
    }

    /// Sets plus template links (policy-studio step 4), no schema validation.
    pub fn from_sets_and_links(sets: &[PolicySource], links: &[PolicyLink]) -> Result<Self, DecisionError> {
        Self::build(sets, None, links)
    }

    /// Sets plus template links, validated against the given Cedar schema (linked instances are validated too:
    /// a link whose value has the wrong entity type for the template is refused like any other rule error).
    pub fn from_sets_with_schema_and_links(sets: &[PolicySource], schema: &str, links: &[PolicyLink]) -> Result<Self, DecisionError> {
        Self::build(sets, Some(schema), links)
    }

    fn build(sets: &[PolicySource], schema: Option<&str>, links: &[PolicyLink]) -> Result<Self, DecisionError> {
        if sets.is_empty() { return Err(DecisionError::Policy("at least one policy set is required".into())); }
        let mut merged = PolicySet::new();
        let mut catalog = Vec::new();
        let mut seen_sets = std::collections::BTreeSet::new();
        let mut templates: std::collections::HashMap<String, PolicyId> = std::collections::HashMap::new();
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
                    text: renamed.to_cedar().unwrap_or_default(), template: None,
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
                    text: renamed.to_cedar(), template: None,
                });
                templates.insert(id.clone(), renamed.id().clone());
                merged.add_template(renamed).map_err(|e| DecisionError::Policy(format!("rule id {id} is used twice: {e}")))?;
            }
        }
        // Template links (policy-studio step 4): instantiate each linked template once per beneficiary. A link naming an unknown
        // template (or a static rule), an invalid slot or uid, a duplicate id or a missing slot value refuses the whole build:
        // a partial rule set never reaches a decision.
        for l in links {
            if !valid_rule_name(&l.id) { return Err(DecisionError::Policy(format!("invalid link id {:?} (letters, digits, - _ . : ; max 80)", l.id))); }
            let template_id = templates.get(&l.template)
                .ok_or_else(|| DecisionError::Policy(format!("link {}: no template named {} (it may be a static rule, which cannot be linked)", l.id, l.template)))?;
            let mut values = std::collections::HashMap::new();
            for (slot, uid) in &l.values {
                let slot = match slot.as_str() {
                    "principal" => SlotId::principal(),
                    "resource" => SlotId::resource(),
                    other => return Err(DecisionError::Policy(format!("link {}: unknown slot {:?} (principal or resource)", l.id, other))),
                };
                values.insert(slot, EntityUid::from_str(uid).map_err(|e| DecisionError::Policy(format!("link {}: invalid {uid}: {e}", l.id)))?);
            }
            merged.link(template_id.clone(), PolicyId::new(&l.id), values)
                .map_err(|e| DecisionError::Policy(format!("link {}: {e}", l.id)))?;
            let linked = merged.policy(&PolicyId::new(&l.id)).ok_or_else(|| DecisionError::Policy(format!("link {}: linked rule missing", l.id)))?;
            let json = linked.to_json().map_err(|e| DecisionError::Policy(e.to_string()))?;
            let n = json.get("conditions").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
            // A linked rule cannot be rendered back to Cedar text (it is data, not text): the catalogue shows the template's text.
            let text = merged.template(template_id).map(|t| t.to_cedar()).unwrap_or_default();
            catalog.push(RuleInfo {
                id: l.id.clone(), set: l.template.rsplit_once('/').map(|(s, _)| s.to_string()).unwrap_or_else(|| "default".into()),
                name: l.id.clone(), kind: "link", effect: effect_name(linked.effect()),
                description: linked.annotation("description").map(str::to_string), pillar: linked.annotation("pillar").map(str::to_string),
                summary: summarize(linked.effect(), &json, n), conditions: n,
                annotations: linked.annotations().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
                text, template: Some(l.template.clone()),
            });
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
        let (request, ents) = cedar_parts(req)?;
        let resp = self.authorizer.is_authorized(&request, &self.policies, &ents);
        let errors: Vec<String> = resp.diagnostics().errors().map(|e| e.to_string()).collect();
        let reasons: Vec<String> = resp.diagnostics().reason().map(|p| p.to_string()).collect();
        // Fail closed: an errored policy is skipped by Cedar, so never trust Allow with errors.
        let allow = resp.decision() == Decision::Allow && errors.is_empty();
        Ok(DecisionResponse { allow, reasons, errors })
    }

    /// Simulates a request against the loaded rules and explains the outcome (policy-studio step 3).
    /// Cedar only names the DECIDING rules; to explain "why denied?" we also evaluate every rule alone:
    /// a permit alone allows exactly when the request satisfies it, a forbid alone names itself in the reasons
    /// exactly when the request satisfies it. Same request, same entities - only the rule under test changes.
    pub fn simulate(&self, req: &DecisionRequest) -> Result<Simulation, DecisionError> {
        let (request, ents) = cedar_parts(req)?;
        let resp = self.authorizer.is_authorized(&request, &self.policies, &ents);
        let errors: Vec<String> = resp.diagnostics().errors().map(|e| e.to_string()).collect();
        let reasons: Vec<String> = resp.diagnostics().reason().map(|p| p.to_string()).collect();
        let allow = resp.decision() == Decision::Allow && errors.is_empty();
        let mut matched_permits = Vec::new();
        let mut matched_forbids = Vec::new();
        let mut errored_rules = Vec::new();
        for p in self.policies.policies() {
            let mut one = PolicySet::new();
            if let (Some(tid), Some(vals)) = (p.template_id(), p.template_links()) {
                // A linked rule cannot be added to a fresh set directly: rebuild it from its template and its slot values.
                let t = self.policies.template(tid).ok_or_else(|| DecisionError::Policy(format!("link {}: template missing", p.id())))?;
                one.add_template(t.clone()).map_err(|e| DecisionError::Policy(e.to_string()))?;
                one.link(tid.clone(), p.id().clone(), vals).map_err(|e| DecisionError::Policy(e.to_string()))?;
            } else {
                // The merged set holds each static rule exactly once with its readable id, so adding it to a fresh set cannot conflict.
                one.add(p.clone()).map_err(|e| DecisionError::Policy(e.to_string()))?;
            }
            let r = self.authorizer.is_authorized(&request, &one, &ents);
            let errs: Vec<String> = r.diagnostics().errors().map(|e| e.to_string()).collect();
            let id = p.id().to_string();
            if !errs.is_empty() {
                errored_rules.push(SimError { id, error: errs.join("; ") });
                continue;
            }
            match p.effect() {
                Effect::Permit if r.decision() == Decision::Allow => matched_permits.push(id),
                Effect::Forbid if r.diagnostics().reason().any(|x| x == p.id()) => matched_forbids.push(id),
                _ => {}
            }
        }
        let templates = self.policies.templates().map(|t| t.id().to_string()).collect::<Vec<_>>();
        let explanation = explain(allow, &reasons, &matched_permits, &matched_forbids, &errored_rules, &templates);
        Ok(Simulation { allow, reasons, errors, matched_permits, matched_forbids, errored_rules, templates, explanation })
    }
}

/// Builds the Cedar request and entities of a decision or simulation request.
fn cedar_parts(req: &DecisionRequest) -> Result<(Request, Entities), DecisionError> {
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
    Ok((request, ents))
}

fn join_ids(ids: &[String]) -> String { ids.join(", ") }

/// The one-sentence "why" of a simulated request, from what matched.
fn explain(allow: bool, reasons: &[String], permits: &[String], forbids: &[String], errored: &[SimError], templates: &[String]) -> String {
    let mut why = if allow {
        format!("ALLOWED by {}. No forbid applies.", join_ids(reasons))
    } else if !forbids.is_empty() {
        let base = format!("DENIED: the forbid {} applies - a forbid always wins over a permit.", join_ids(forbids));
        if permits.is_empty() { format!("{base} No permit would have allowed the request anyway.") }
        else { format!("{base} The permit {} matched too, but the forbid overrules it.", join_ids(permits)) }
    } else if !errored.is_empty() && !permits.is_empty() {
        format!("DENIED (fail closed): the permit {} would allow, but the rule {} errored and Cedar skips an errored rule, so the request is refused.",
            join_ids(permits), join_ids(&errored.iter().map(|e| e.id.clone()).collect::<Vec<_>>()))
    } else {
        "DENIED: no rule permits this request.".to_string()
    };
    if !allow && !errored.is_empty() && (permits.is_empty() || !forbids.is_empty()) {
        why.push_str(&format!(" Also, the rule {} errored and was skipped.", join_ids(&errored.iter().map(|e| e.id.clone()).collect::<Vec<_>>())));
    }
    if !templates.is_empty() {
        why.push_str(&format!(" Templates never apply until linked per person, role or resource ({} not linked).", join_ids(templates)));
    }
    why
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


    // ---- Simulator: why allowed / why denied (policy-studio step 3) ----

    fn sim(e: &Engine, principal: &str, action: &str, ctx: serde_json::Value) -> Simulation {
        e.simulate(&dreq(principal, action, ctx, json!([]))).unwrap()
    }

    const SIM_RULES: &str = r#"
@id("approvers-approve") permit(principal, action == Action::"approve", resource) when { context has roles && context.roles.contains("payment-approver") };
@id("sod-blocks") forbid(principal, action == Action::"approve", resource) when { context has sod_conflict && context.sod_conflict == true };
@id("everyone-reads") permit(principal, action == Action::"read", resource);
"#;

    #[test]
    fn simulation_of_an_allow_names_the_matching_permit_and_no_forbid() {
        let e = Engine::new(SIM_RULES).unwrap();
        let r = sim(&e, r#"User::"alice""#, r#"Action::"read""#, json!({}));
        assert!(r.allow);
        assert_eq!(r.matched_permits, vec!["everyone-reads"]);
        assert!(r.matched_forbids.is_empty() && r.errored_rules.is_empty());
        assert_eq!(r.reasons, vec!["everyone-reads"]); // same as a real decision
        assert!(r.explanation.contains("ALLOWED by everyone-reads"), "{}", r.explanation);
    }

    #[test]
    fn simulation_explains_a_forbid_overruling_a_matching_permit() {
        let e = Engine::new(SIM_RULES).unwrap();
        let r = sim(&e, r#"User::"alice""#, r#"Action::"approve""#, json!({"roles": ["payment-approver"], "sod_conflict": true}));
        assert!(!r.allow);
        assert_eq!(r.matched_permits, vec!["approvers-approve"]);
        assert_eq!(r.matched_forbids, vec!["sod-blocks"]);
        assert_eq!(r.reasons, vec!["sod-blocks"]); // the deciding rule, as in the audit
        assert!(r.explanation.contains("forbid sod-blocks applies"), "{}", r.explanation);
        assert!(r.explanation.contains("approvers-approve matched too, but the forbid overrules it"), "{}", r.explanation);
    }

    #[test]
    fn simulation_explains_a_deny_with_no_matching_permit() {
        let e = Engine::new(SIM_RULES).unwrap();
        // A person without the role, no SoD conflict: denied because NO permit matches.
        let r = sim(&e, r#"User::"carol""#, r#"Action::"approve""#, json!({"roles": ["viewer"]}));
        assert!(!r.allow);
        assert!(r.matched_permits.is_empty() && r.matched_forbids.is_empty());
        assert!(r.explanation.contains("no rule permits this request"), "{}", r.explanation);
        // Same request with a SoD conflict: the forbid decides, and no permit would have allowed it anyway.
        let r = sim(&e, r#"User::"carol""#, r#"Action::"approve""#, json!({"roles": ["viewer"], "sod_conflict": true}));
        assert!(!r.allow);
        assert_eq!(r.matched_forbids, vec!["sod-blocks"]);
        assert!(r.explanation.contains("No permit would have allowed the request anyway"), "{}", r.explanation);
    }

    #[test]
    fn simulation_reports_an_errored_rule_and_fails_closed() {
        // A rule reading an unguarded attribute errors when the attribute is absent; Cedar skips it, the engine refuses.
        let e = Engine::new(r#"
@id("fragile") permit(principal, action == Action::"read", resource) when { context.level > 3 };
@id("fallback") permit(principal, action == Action::"read", resource);
"#).unwrap();
        let r = sim(&e, r#"User::"alice""#, r#"Action::"read""#, json!({}));
        assert!(!r.allow, "fail closed: fallback matched but fragile errored");
        assert_eq!(r.matched_permits, vec!["fallback"]);
        assert_eq!(r.errored_rules.len(), 1);
        assert_eq!(r.errored_rules[0].id, "fragile");
        assert!(r.explanation.contains("DENIED (fail closed)"), "{}", r.explanation);
        assert!(r.explanation.contains("fragile"), "{}", r.explanation);
        // With the attribute present the same rules allow cleanly.
        let r = sim(&e, r#"User::"alice""#, r#"Action::"read""#, json!({"level": 1}));
        assert!(r.allow);
        assert!(r.errored_rules.is_empty());
    }

    #[test]
    fn simulation_lists_templates_as_never_applicable_until_linked() {
        let e = Engine::new(r#"
@id("delegated-read") permit(principal == ?principal, action == Action::"read", resource);
@id("everyone-reads") permit(principal, action == Action::"read", resource);
"#).unwrap();
        let r = sim(&e, r#"User::"alice""#, r#"Action::"read""#, json!({}));
        assert!(r.allow);
        assert_eq!(r.templates, vec!["delegated-read"]);
        assert!(r.explanation.contains("never apply until linked"), "{}", r.explanation);
    }

    #[test]
    fn simulation_works_across_sets_and_validates_the_same_inputs() {
        let e = Engine::from_sets(&[
            src("sso", r#"@id("wiki") permit(principal, action == Action::"open", resource);"#),
            src("sod", r#"@id("freeze") forbid(principal, action == Action::"open", resource) when { context has frozen && context.frozen == true };"#),
        ]).unwrap();
        let r = sim(&e, r#"User::"alice""#, r#"Action::"open""#, json!({"frozen": true}));
        assert!(!r.allow);
        assert_eq!(r.matched_permits, vec!["sso/wiki"]);
        assert_eq!(r.matched_forbids, vec!["sod/freeze"]);
        // Bad input is refused exactly like a decision.
        assert!(e.simulate(&dreq("not-an-entity", r#"Action::"open""#, json!({}), json!([]))).is_err());
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

    // ---- Template links in the engine (policy-studio step 4) ----

    fn link(id: &str, template: &str, values: &[(&str, &str)]) -> PolicyLink {
        PolicyLink { id: id.into(), template: template.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }
    }

    const TPL_SETS: &str = r#"
@id("delegated-read") @description("Read granted to one beneficiary") @pillar("sso")
permit(principal == ?principal, action == Action::"read", resource == ?resource);
@id("everyone-reads") permit(principal, action == Action::"read", resource);
"#;

    #[test]
    fn a_linked_template_decides_and_the_audit_names_the_link() {
        let e = Engine::from_sets_and_links(&[src("sso", TPL_SETS)], &[
            link("delegate:alice:r1", "sso/delegated-read", &[("principal", r#"User::"alice""#), ("resource", r#"Resource::"r1""#)]),
        ]).unwrap();
        // The template itself never applies: nobody gets allowed by it directly...
        let d = |who: &str, res: &str| e.decide(&dreq(who, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        // ...everyone-reads permits all reads here, so use a set without it to prove the link's effect.
        let e2 = Engine::from_sets_and_links(&[src("sso", r#"@id("delegated-read") permit(principal == ?principal, action == Action::"read", resource == ?resource);"#)], &[
            link("delegate:alice:r1", "sso/delegated-read", &[("principal", r#"User::"alice""#), ("resource", r#"Resource::"r1""#)]),
        ]).unwrap();
        // dreq fixes the resource to r1, so build the r2 request explicitly.
        let d2 = |who: &str, res: &str| e2.decide(&DecisionRequest { principal: who.into(), action: r#"Action::"read""#.into(), resource: res.into(), context: json!({}), entities: json!([]) }).unwrap();
        let r = d2(r#"User::"alice""#, r#"Resource::"r1""#);
        assert!(r.allow);
        assert_eq!(r.reasons, vec!["delegate:alice:r1"]);
        assert!(!d2(r#"User::"alice""#, r#"Resource::"r2""#).allow, "the link only covers its resource");
        assert!(!d2(r#"User::"carol""#, r#"Resource::"r1""#).allow, "the link only covers its person");
        let _ = d(r#"User::"alice""#, r#"Resource::"r1""#);
        // The catalogue lists the link, its template and the template's annotations.
        let entry = e.catalog().iter().find(|r| r.id == "delegate:alice:r1").unwrap();
        assert_eq!((entry.kind, entry.template.as_deref(), entry.description.as_deref()), ("link", Some("sso/delegated-read"), Some("Read granted to one beneficiary")));
        // A forbid still wins over a per-person grant.
        let e3 = Engine::from_sets_and_links(&[
            src("sso", r#"@id("delegated-read") permit(principal == ?principal, action == Action::"read", resource == ?resource);"#),
            src("sod", r#"@id("freeze") forbid(principal, action, resource) when { context has frozen && context.frozen == true };"#),
        ], &[link("delegate:alice:r1", "sso/delegated-read", &[("principal", r#"User::"alice""#), ("resource", r#"Resource::"r1""#)])]).unwrap();
        let r = e3.decide(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({"frozen": true}), json!([]))).unwrap();
        assert!(!r.allow);
        assert_eq!(r.reasons, vec!["sod/freeze"]);
    }

    #[test]
    fn a_link_per_role_applies_through_entity_parents() {
        let e = Engine::from_sets_and_links(&[src("default", r#"@id("role-read") permit(principal in ?principal, action == Action::"read", resource);"#)], &[
            link("role-read:auditor", "role-read", &[("principal", r#"Role::"auditor""#)]),
        ]).unwrap();
        let ents = json!([
            {"uid":{"type":"User","id":"bob"},"attrs":{},"parents":[{"type":"Role","id":"auditor"}]},
            {"uid":{"type":"Role","id":"auditor"},"attrs":{},"parents":[]}
        ]);
        let r = e.decide(&dreq(r#"User::"bob""#, r#"Action::"read""#, json!({}), ents.clone())).unwrap();
        assert!(r.allow);
        assert_eq!(r.reasons, vec!["role-read:auditor"]);
        assert!(!e.decide(&dreq(r#"User::"carol""#, r#"Action::"read""#, json!({}), ents)).unwrap().allow);
    }

    #[test]
    fn a_bad_link_refuses_the_whole_build() {
        let sets = [src("sso", TPL_SETS)];
        // Unknown template (or a static rule used as a template).
        let err = Engine::from_sets_and_links(&sets, &[link("l1", "sso/no-such-template", &[("principal", r#"User::"a""#)])]).err().unwrap();
        assert!(err.to_string().contains("l1") && err.to_string().contains("sso/no-such-template"), "{err}");
        let err = Engine::from_sets_and_links(&sets, &[link("l1", "sso/everyone-reads", &[("principal", r#"User::"a""#)])]).err().unwrap();
        assert!(err.to_string().contains("l1"), "{err}");
        // A missing slot value is refused (Cedar rejects an incomplete link).
        assert!(Engine::from_sets_and_links(&sets, &[link("l1", "sso/delegated-read", &[("principal", r#"User::"a""#)])]).is_err());
        // An invalid slot name, an invalid uid, an invalid link id.
        assert!(Engine::from_sets_and_links(&sets, &[link("l1", "sso/delegated-read", &[("action", r#"User::"a""#)])]).is_err());
        assert!(Engine::from_sets_and_links(&sets, &[link("l1", "sso/delegated-read", &[("principal", "not-a-uid"), ("resource", r#"Resource::"r1""#)])]).is_err());
        assert!(Engine::from_sets_and_links(&sets, &[link("bad id", "sso/delegated-read", &[("principal", r#"User::"a""#), ("resource", r#"Resource::"r1""#)])]).is_err());
        // A link id colliding with a rule, a template or another link is refused.
        assert!(Engine::from_sets_and_links(&sets, &[link("sso/everyone-reads", "sso/delegated-read", &[("principal", r#"User::"a""#), ("resource", r#"Resource::"r1""#)])]).is_err());
        let two = [link("l1", "sso/delegated-read", &[("principal", r#"User::"a""#), ("resource", r#"Resource::"r1""#)]),
                   link("l1", "sso/delegated-read", &[("principal", r#"User::"b""#), ("resource", r#"Resource::"r2""#)])];
        assert!(Engine::from_sets_and_links(&sets, &two).is_err());
    }

    #[test]
    fn the_schema_validates_rules_and_templates_and_a_mistyped_link_just_never_matches() {
        // Verified Cedar behaviour: the validator checks the rules and the templates, NOT the slot values of a link
        // (a template stays generic). A link whose value has the wrong entity type builds fine but matches no request -
        // a dead grant, not a safety hole. The console therefore picks link values from existing people/roles/organisations.
        let schema = r#"
entity Role;
entity User in [Role];
entity Resource;
action "read" appliesTo { principal: [User], resource: [Resource] };
"#;
        let sets = [src("default", r#"@id("delegated-read") permit(principal == ?principal, action == Action::"read", resource == ?resource);"#)];
        let ok = Engine::from_sets_with_schema_and_links(&sets, schema, &[
            link("delegate:alice:r1", "delegated-read", &[("principal", r#"User::"alice""#), ("resource", r#"Resource::"r1""#)])]).unwrap();
        assert!(ok.validated());
        let r = ok.decide(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        assert!(r.allow);
        assert_eq!(r.reasons, vec!["delegate:alice:r1"]);
        let mistyped = Engine::from_sets_with_schema_and_links(&sets, schema, &[
            link("delegate:r1:r1", "delegated-read", &[("principal", r#"Resource::"r1""#), ("resource", r#"Resource::"r1""#)])]).unwrap();
        assert!(mistyped.validated(), "the schema does not type-check link values (verified)");
        assert!(!mistyped.decide(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({}), json!([]))).unwrap().allow, "a mistyped link matches nothing");
    }

    #[test]
    fn the_simulator_sees_links_and_still_lists_templates() {
        let e = Engine::from_sets_and_links(&[src("default", TPL_SETS)], &[
            link("delegate:alice:r1", "delegated-read", &[("principal", r#"User::"alice""#), ("resource", r#"Resource::"r1""#)])]).unwrap();
        let r = e.simulate(&dreq(r#"User::"alice""#, r#"Action::"read""#, json!({}), json!([]))).unwrap();
        assert!(r.allow);
        assert!(r.matched_permits.contains(&"delegate:alice:r1".to_string()), "{r:?}");
        assert_eq!(r.templates, vec!["delegated-read"], "the template itself stays listed as not generally applicable");
    }

}
