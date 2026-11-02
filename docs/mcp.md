# MCP server: branch-confined AI access (demo)

The platform exposes a **Model Context Protocol** server (streamable HTTP, spec revision 2025-11-25) so an AI
assistant (Claude, ChatGPT, VS Code Copilot, any MCP client) can read the platform's data and prepare changes:
users, roles, assignments, plugin configuration, any versioned table. Like a human administrator, the AI works
on a **Dolt data branch** and its work only reaches `main` through a **human-reviewed data pull request**.

Everything below is enforced **server-side**. None of it relies on instructions given to the model.

## Connecting an AI client

1. In the admin console, **MCP** page: create a session (label + lifetime, default 8 h, max 7 days).
2. The console shows the session secret **once**. It is never stored in clear (SHA-256 hash only) and never shown again.
3. Configure the client, e.g. Claude Desktop:

```json
{
  "mcpServers": {
    "iam-poc": {
      "url": "https://<host>/tenants/acme-demo/mcp",
      "headers": { "Authorization": "Bearer <session secret>" }
    }
  }
}
```

### Authentication model, stated honestly

This is **not** a full OAuth 2.1 authorization server. Sessions are pre-registered bearer credentials (the
"pre-registered client credentials" approach the MCP authorization spec allows). For discovery the endpoint
answers `401` with a `WWW-Authenticate` header pointing at RFC 9728 protected-resource metadata
(`/.well-known/oauth-protected-resource/tenants/<tenant>/mcp`). Tokens travel in the `Authorization` header only,
never in the URL. Cross-origin browser posts are refused (403). Secrets are opaque random strings, **not** IdP
tokens: they open only the MCP route, and every other route of the platform keeps requiring a normal sign-in.

## What the AI can do

| Area | Tools |
| --- | --- |
| Read data | `list_users` (no credential fields), `list_tables`, `read_table`, `query` (one read-only statement), `list_branches`, `diff_vs_main`, `list_pull_requests`, `session_status` |
| Read configuration | `list_roles`, `list_organizations`, `list_plugins`, `get_authn_config`, `list_workflows`, `get_workflow`, `list_workflow_runs`, `list_event_records` (event bus observability, scrubbed; the bus has no write route anywhere) |
| Prepare users and roles | `execute_write` (filtered write SQL, one Dolt commit), `upsert_user` (created users have `login_enabled=false` and no known password), `assign_role` / `unassign_role`, `save_role`, `delete_role`, `add_sod_rule`, `remove_sod_rule` (needs `confirm=true`: it loosens a control) |
| Prepare configuration | `save_profile_config` (profile fields, validated against the catalogue), `create_organization` / `update_organization` / `delete_organization` / `assign_organizations`, `install_plugin` / `configure_plugin` / `set_plugin_enabled` (sensitive grants - ui components, event hooks - stay console-only), `save_authn_config` (sign-in methods and chains, validated against the methods catalogue) |
| Prepare workflows | `save_workflow` (create or edit a definition: name, steps graph, start trigger), `delete_workflow`, `test_workflow` (simulated preview of the branch definition with a sample event payload). What it proves: the graph is valid and the placeholder substitution is correct. What it does NOT prove: the real behavior of the steps - nothing is executed, written, sent or stored, so a step that would fail at run time (unknown role, refused write) still passes the preview |
| Work cycle | `request_new_branch` (fresh branch **from main**), `rebase_on_main` (merge main in, conflicts reported), `submit_pull_request` (opens the PR for human review) |

Reads and writes run on the session branch through the **same guarded services as the human console**: the SQL
filters (`checkSql`), branch write guards, SoD checks, plugin registry, profile/authentication validators and
the workflow graph validator are shared code, not copies. Feature gates also match the console: organization
tools need the organizations plugin enabled on the branch, workflow tools need workflows-iga.

**Workflow definitions are versioned** (table `workflow_definitions` in the Dolt database, migrated once from
the old meta storage at startup): the AI creates and edits them on its branch, the diff is reviewed in the data
pull request, and they only go live when a human applies it. Runs and steps (execution state) stay unversioned
in the meta database, and a manual or triggered run always uses the **live** (main) definition, never an
unreviewed branch edit. Pre-migration meta rows are copied to main exactly once (a `defs_migrated` marker
prevents resurrecting a definition deleted after the migration).

Explicitly **not** covered by the MCP surface: starting or cancelling workflow runs (they execute effects),
publishing/applying anything to main, user credential enrollments and the outbox, and the Cedar policies
themselves (they live in git, not in Dolt: changing them is a code review, not a data pull request).

## What the AI can never do

- **Write to main.** A branch is created automatically when the session opens; writes outside it are impossible
  (the branch is forced server-side on every call; `main` refuses writes outside the human Apply flow).
- **Approve, merge or close a pull request, or Apply to main.** There is no tool for it, and the routes that do
  it require an IdP token plus the admin capability. An MCP secret gets 401 there, by construction.
- **Choose an existing branch.** It can only ask for a *new* branch (cut from main) or rebase its own on main.
- **Escalate its own powers.** Granting itself `mcp-operator` (or any role) on its branch changes nothing live:
  per-call decisions are computed by the core from the **active version** (main), so the grant only counts after
  a human merges it and Apply activates it. (Covered by an end-to-end test.)
- **Read secrets.** The outbox (simulated 2FA mail codes), credential references, any table/column whose name
  contains `secret`/`token`/`password`, the meta database (sessions, PRs) and `information_schema` are refused.
  The check runs on the SQL *skeleton* (literals emptied, comments stripped), so aliases, CTEs, subqueries and
  pre-made views cannot smuggle a sensitive name past it; adversarial shapes are covered by tests.
- **Execute effects.** `save_workflow` only prepares a definition; no tool starts or cancels a run, so no
  notification, role grant or provisioning can fire from an MCP call. Sensitive plugin grants (ui components,
  event hooks) are never granted by MCP tools: they remain a human console action.

## Authorization per call

Every `tools/call` is authorized by the **same Cedar policy engine as humans** (the Rust core), in tenant mode,
as the session owner: `Action::"mcp:read" | "mcp:write" | "mcp:lifecycle"` on `Branch::"<session branch>"`.
The demo policies require the `mcp-operator` role (seeded, assigned to `demo-alice`). If the core is
unreachable the call is denied (fail closed). Every decision is written to the decision audit
(`source = 'agent'`, note carries the session and tool).

## Traceability

Every call lands in `mcp_activity` (meta database): session, owner, branch, tool, kind (read/write/lifecycle),
the SQL skeleton (never literal values), the target tables, allow/deny with reasons, row counts, errors.
The console MCP page shows the journal per session. Sessions are revocable at any time; expiry kills them too.

## Limits (POC)

- Stateless streamable HTTP: JSON responses, no SSE resumability, one request = one JSON-RPC message.
- The demo's free hosting loses data on restart: sessions and their trace disappear with it.
- The lexical confinement is defense in depth on top of the console's SQL guards, not a formal proof; the real
  boundary is that the MCP identity structurally cannot reach publishing routes.
