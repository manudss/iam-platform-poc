# Policy studio (Cedar rules) - step 1: read-only catalogue

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

## Limits of step 1

Read-only. No editor, no schema validation, no simulator, no impact analysis. Summaries are generated from the rule scope and the number of conditions; the conditions themselves are read in the Cedar text. Usage counts come from the audit window (last 500 decisions of the tenant at most; the in-memory audit is lost on restart).

## Tests

- Rust: `cargo test` in `core` (rule names, sets, composition, templates, catalogue endpoint, directory loading).
- API: `policies/policy-studio.spec.ts` (endpoint, plugin gate, usage) and `policies/policy-studio.e2e.spec.ts` (real core binary, readable names in reasons and audit).
- Web: `policies.spec.ts` (filters and wording).
