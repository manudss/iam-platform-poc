# MCP gateway (P1): relaying external MCP servers

The platform can relay **external MCP servers** (Jira, GitHub, any remote MCP) to the AI assistants connected
to its own MCP endpoint. An administrator registers an upstream once; its tools then appear in every MCP
session as **`<name>__<tool>`** (e.g. `jira__getIssue`), next to the local tools.

This is the *MCP gateway* pattern, built the way the MCP specification imposes it:

- **No token passthrough** (spec, security best practices). The agent's session secret terminates at the
  platform. The relay authenticates to the upstream with the upstream's **own token**, stored in the
  registry. Neither token ever crosses to the other side: the agent never sees the upstream token, the
  upstream never sees the agent's session secret.
- **The agent never chooses the target** (SSRF protection). Only an administrator can register an upstream
  URL. `http` is accepted only towards loopback hosts (local demo/tests); anything remote requires `https`.
  `IAM_MCP_UPSTREAM_HOSTS` (comma-separated hostnames) optionally restricts the allowed hosts further.
- **Every call is authorized and traced.** Each relayed call goes through the same Cedar decision as the
  local tools - `Action::"mcp:proxy"` as the session owner, `mcp-operator` role required from the ACTIVE
  version - and lands in `mcp_activity` with kind **`proxy`**: session, owner, upstream host, duration and
  the **sha256 of the arguments**. Arguments are never logged in clear (they can carry personal data or
  secrets), and the upstream token is redacted from any error before it is recorded.

## Registering an upstream

Console, **MCP** page, *External MCP servers*: name (slug, becomes the tool prefix), URL, token. The token is
stored encrypted (AES-256-GCM, key from `IAM_MCP_UPSTREAM_KEY` - POC grade; a real deployment injects a
KMS/vault-managed key) and **never displayed again**. The *Test* button runs a live `tools/list` and records
the outcome on the row.

API equivalent (admin):

```
POST   /tenants/<tenant>/mcp-upstreams           { "name": "jira", "url": "https://...", "token": "..." }
GET    /tenants/<tenant>/mcp-upstreams           (never contains the token, not even encrypted)
POST   /tenants/<tenant>/mcp-upstreams/:id/test  { ok, tools, error }
DELETE /tenants/<tenant>/mcp-upstreams/:id
```

An MCP session secret gets **401** on these routes: an AI cannot register, modify or even read the upstream
configuration, by construction.

## Trying it locally with the fake upstream

`scripts/fake-upstream-mcp.mjs` is a zero-dependency sandbox "Jira" MCP (streamable HTTP, Bearer token):

```sh
node scripts/fake-upstream-mcp.mjs --port 4100 --token demo-upstream-token
```

Register `http://127.0.0.1:4100` with that token in the console, open an MCP session, and `tools/list` shows
`fake__searchIssues`, `fake__getIssue`, `fake__createIssue`. Every call appears in the session trace with
kind `proxy`.

## Behavior and limits (P1)

- **Tool fidelity.** Upstream tools are served with their real names (prefixed) and their JSON schemas
  (converted best-effort: primitives, enums, arrays, objects; exotic constructs degrade to "any"). An
  unreachable upstream simply contributes no tools - local tools and other upstreams are unaffected.
- **Untrusted content is marked.** Relayed descriptions are prefixed `[relay -> <name>]`: tool descriptions
  and results from an external server are untrusted input for the model (description injection is the top
  MCP risk). Pinning/rewriting descriptions and filtering arguments/responses are later increments (P4/P5).
- **Relayed tools are filtered by per-identity grants (P2).** See the next section.
- **Real Jira works (P3).** See the P3 section: Atlassian Rovo MCP, API-token (Basic) auth, paginated catalog.
- **Proxied calls are external side effects**, not branch writes: they stay possible after the session
  submitted its pull request (the read-only-after-submit rule covers the session's own branch only).
- The upstream tool list is cached 60 s per upstream; the console *Test* button forces a refresh.

## P2 - per-tool delegation grants

A relayed tool is usable only when **both** hold for the session owner:

1. a row of `delegation_grants` covers it in the **active version** (identity + upstream + tool, optional
   `expires_at`), and
2. the Cedar policy allows the call (`mcp:proxy` requires the `mcp-operator` role and the grant in context).

Enforcement is server-side at two levels, always from the active version, never from a branch:

- `tools/list` only shows the relayed tools the caller's active grants cover - an ungranted tool is
  invisible, not just refused;
- every relayed `tools/call` is re-authorized by Cedar with the active grants injected as
  `UpstreamTool::"<upstream>__<tool>"` entities in `context.mcp_grants`.

The table is **versioned data** in the business Dolt database (seeded for the demo, DDL in
`data/demo/01-schema.sql`). So a grant changes exactly like a role: anyone (human or AI) writes it on a
working branch, opens a pull request, a human merges, the new version is activated. An AI session can
therefore *propose* a grant for itself (`execute_write` + `submit_pull_request`) with zero effect until a
human publishes it - the same SoD story as the rest of the platform. There is deliberately **no direct-write
route**: the console's *Delegation grants* section is read-only (`GET /tenants/:tenant/mcp-grants`, admin)
and always shows the active version with its commit.

An expired grant (`expires_at` in the past) stops filtering in at both levels; the row stays in the
version history for audit. The demo seeds show the two boundary cases: `demo-alice` has read tools on the
fake upstream but not `createIssue`, and `demo-bob` has a `getIssue` grant without the `mcp-operator` role -
the tool is listed for him, yet Cedar still denies the call. The allowlist is never the last word.

## P3 - real Jira (Atlassian Rovo MCP)

The gateway now connects to the **real Atlassian Rovo MCP** on a sandbox Jira site. Read-only first: the demo
grants cover only read tools; a write tool (e.g. `createJiraIssue`) requires the same versioned flow as P2 -
the AI proposes the grant on its branch, a human merges, the new version is activated. "Write behind approval"
IS the P2 grant mechanism applied to a production upstream.

### Registering the Rovo MCP

- **URL**: `https://mcp.atlassian.com/v2/mcp?tools=all`. The `?tools=all` flat list matters: by default the
  Rovo MCP advertises only a few primary tools and routes everything else through the `discover` +
  `executeRead` / `executeWrite` / `executeDestructive` meta-tools. A per-tool allowlist cannot see through
  those - granting `executeWrite` would silently open every deferred write tool. With the flat list, each
  Jira tool is listed, granted and traced individually.
- **Auth**: `basic` - the Atlassian API-token scheme for machine-to-machine access. The console asks for the
  Atlassian **account email** (stored in clear, shown in the list) and the **API token** (stored encrypted,
  never shown again); the relay sends `Authorization: Basic base64(email:token)`. OAuth 2.1 remains the
  Atlassian-recommended interactive scheme and is the target montage (consent carried by the IAM grant);
  the API token is the simple, revocable demo montage.
- **Prerequisites on the Atlassian side** (org admin): a sandbox Jira Cloud site (the free tier is enough),
  API-token authentication enabled for the Rovo MCP in the organization settings, and a scoped API token
  (`read:jira:agent-interface`, `search:jira:agent-interface` for the read-only demo; the `write:` scope can
  be added later without any platform change - the grant still gates each tool).
- The upstream tool list is **paginated** there: the relay follows `nextCursor` (bounded at 10 pages) so the
  complete catalog is visible to the grant filter.

The demo seeds pre-grant `demo-alice` the read tools on an upstream named `jira`
(`atlassianUserInfo`, `getAccessibleAtlassianResources`, `searchJiraIssuesUsingJql`, `getJiraIssue`,
`listJiraProjects`, `listJiraIssueComments`) - register the Rovo MCP under that name and the story works out
of the box: Jira read tools appear in her AI sessions, `jira__createJiraIssue` stays invisible, and the
`discover`/`execute*` meta-tools are deliberately never seeded (they would bypass the per-tool allowlist).

### Auth schemes on the registry (API)

`POST /tenants/<tenant>/mcp-upstreams` accepts `authType: "bearer" (default) | "basic"` and, for `basic`,
`authUser` (the upstream account email or id). The derived credential is redacted from errors and traces
exactly like the raw token. Existing registries migrate automatically (the two columns are added on first
use; nothing to run by hand).
