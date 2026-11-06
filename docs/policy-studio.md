# Policy studio (Cedar rules) - step 1: read-only catalogue; step 2: schema validation; step 3: the "why refused?" simulator

The platform decides every access with [Cedar](https://docs.cedarpolicy.com/) rules inside the Rust core. This plugin shows those rules.
Step 1 changes nothing about a decision: it names the rules, lists them, and makes the decision audit say which rule decided.

## What you get

- **Named rules.** Every rule in `policies/demo.cedar` carries three annotations: `@id("...")` (the readable name), `@description("...")` and `@pillar("...")` (a grouping label such as `human`, `sod`, `mcp`).
- **Decisions name the rule.** `reasons` in a decision answer (and so the decision audit) now holds the `@id`, for example `["sod-blocks-approve"]`, instead of Cedar's generated `policy3`. A rule without `@id` keeps the generated name. Cedar errors name the rule the same way.
- **`GET /v1/policies` on the core** (header `x-core-admin-token`): the loaded rules, with effect, group, a plain-language reading generated from the rule, the Cedar text, and the set it belongs to.
- **Console screen "Policies"** (menu Access (IAM), visible when the plugin `policy-studio` is enabled on the branch): filter by group, effect or text, open the Cedar text of a rule, see how many of the last audited decisions used it (allowed / denied). The demo seed enables the plugin.
- **API** `GET /tenants/:tenant/policies` (administrator capability, 404 while the plugin is off, 503 when the core is not configured or not reachable). It joins the catalogue with the audit of that tenant only.

## Several rule sets

The engine accepts several named sets and merges them into one Cedar set, so the usual Cedar rules apply across sets: any matching `forbid` wins over any `permit`, whichever set holds them. The reason then names the deciding rule with its set, for example `sod/freeze`.

`IAM_POLICY_FILE` can be a file (one set called `default`, ids shown as is) or a directory (every `*.cedar` file is one set named after the file, ids shown as `<set>/<id>`). A broken file refuses the whole load: the core never starts with a partial or empty rule set. The default stays `policies/demo.cedar`.

Rule ids must be unique inside a set; the same id in two sets is allowed because the set prefixes it.

## Per person, per role, per context (what Cedar really does)

These points are covered by unit tests in `core/crates/iam-decision/src/lib.rs`:

- **Rules are evaluated per request.** A rule reads the person (`principal` and its attributes, e.g. `principal.department`), the resource and the `context` of that request, so the same rule gives different answers to different people. Roles are entity parents (`principal in Role::"auditor"`).
- **Templates** (`principal == ?principal`, `resource == ?resource`) are rules with slots. Cedar *links* a template once per beneficiary (one person, one role, one organisation): the link is a new policy id. A link only covers the values it was created with.
- **forbid wins**, also over a linked per-person grant and across sets.
- Cedar does not take the policy id from `@id` when it parses text. The engine reads `@id` itself and renames the rule, which is what the audit shows.

Not done yet: the engine does not create template links (step 4 stores them in Dolt), and rules are still read from files, not from Dolt.

## Schema validation (step 2)

The rules are validated against a [Cedar schema](https://docs.cedarpolicy.com/policies/validation.html) before the engine can decide
anything: a rule that names an unknown action, entity type or attribute, reads a value of the wrong type, or reads an optional
attribute without a `has` guard is REFUSED, and the core does not start on it (the error names the rule, e.g. `[sod-blocks-approve] ...`).
This is the strict Cedar validation, the one the later SymCC analysis (step 6) also assumes.

- **The schema is `policies/demo.cedarschema`** (cedarschema syntax). It declares the POC nouns (`User`, `Role`, the resource types),
  the actions (`approve`, `read`, `mcp:read` / `mcp:write` / `mcp:lifecycle`, and `mcp:proxy` for the gateway branch) and the context
  each action carries. The tenant context attributes (`tenant_mode`, `roles`, `sod_conflict`) are all OPTIONAL, because a request without
  tenant data carries none of them: rules must guard their reads with `context has ...` (the `sod-blocks-approve` rule shows the pattern).
- **Which schema applies:** `IAM_POLICY_SCHEMA` when set - a set but unreadable or invalid schema refuses the start, a demanded check is
  never silently skipped - else the sibling of the rules when it exists (`x.cedar` -> `x.cedarschema`; in a directory of sets,
  `schema.cedarschema`), else no validation (legacy behaviour).
- **In CI:** the check runs inside `cargo test` (the demo rules are validated against the shipped schema), with a named step
  "Validate the Cedar rules against their schema" so a failure is obvious in the run summary.
- **Visible in the console:** the Policies screen says whether the loaded rules were validated (`engine.schema` in the catalogue
  answers), and the API relays the flag unchanged.

One rule text changed for this: `sod-blocks-approve` now reads `context has sod_conflict && context.sod_conflict == true`. Reading an
optional attribute without the guard errored at evaluation time (the rule was skipped and the decision denied); with the guard the
forbid simply does not apply when the attribute is absent. In tenant mode the core always injects the attribute, so nothing changes there.

## The simulator: why refused? (step 3)

The Policies screen ends with a **simulator**: type a person, an action, a resource and a context, and the core answers what it
WOULD decide and why. Cedar only names the deciding rule; the simulator also evaluates every rule alone, so the answer lists
every permit and every forbid the request satisfies, the rules that errored (Cedar skips an errored rule, the engine refuses
fail-closed), and the templates (never applicable until linked per person, role or resource). A one-sentence explanation sums
it up: "DENIED: the forbid sod-blocks-approve applies - a forbid always wins over a permit. The permit ... matched too, but the
forbid overrules it."

- **Core**: `POST /v1/policies/simulate` (admin token), body exactly like `/v1/decide` (`principal`, `action`, `resource`, optional
  `context`, `entities`). The simulator takes the request as given: it never reads a tenant's active version (in tenant mode a real
  decision would overwrite `roles` / `sod_conflict` with the active data - here you explore the context you type, which is the point).
- **API**: `POST /tenants/:tenant/policies/simulate` (administrator capability, plugin gate, 503 without the core, 400 on a malformed request).
- **Console**: the simulator card under the catalogue (own components). The context field is free JSON, validated before sending.
- Read-only like steps 1-2: a simulation decides nothing, writes nothing to the audit, changes nothing.

## Limits of steps 1-3

Read-only. No editor, no impact analysis. The simulator evaluates the request you type; it does not look up the tenant's active version (so `roles` and `sod_conflict` are yours to set, not read from Dolt), and it does not create template links (step 4). The schema covers the current actions; a rule set introducing a new action
needs the schema extended first (on purpose: the schema is the contract of what a rule may name). Summaries are generated from the rule scope and the number of conditions; the conditions themselves are read in the Cedar text. Usage counts come from the audit window (last 500 decisions of the tenant at most; the in-memory audit is lost on restart).

## Tests

- Rust: `cargo test` in `core` (rule names, sets, composition, templates, catalogue endpoint, directory loading, simulator engine and endpoint).
- API: `policies/policy-studio.spec.ts` (endpoint, plugin gate, usage, simulator request checks) and `policies/policy-studio.e2e.spec.ts` (real core binary, readable names in reasons and audit, simulation answers).
- Web: `policies.spec.ts` (filters, wording, simulator context parsing).
