// Demo policies (fictional identities). forbid always wins over permit.
// Every rule carries @id (the readable name shown in the decision audit and the Policies screen), @description and @pillar (grouping label).
// Static demo rules apply only to requests WITHOUT tenant data (no context.tenant_mode).
@id("demo-alice-approves")
@description("Demo identity alice may approve (only for requests without tenant data).")
@pillar("human")
permit(principal == User::"alice", action == Action::"approve", resource) unless { context has tenant_mode };
@id("demo-bob-reads")
@description("Demo identity bob may read (only for requests without tenant data).")
@pillar("human")
permit(principal == User::"bob",   action == Action::"read",    resource) unless { context has tenant_mode };
// Tenant mode: roles and sod_conflict are computed by the core from the ACTIVE data version, not supplied by the caller.
@id("approve-needs-payment-approver")
@description("A person holding the payment-approver role may approve.")
@pillar("human")
permit(principal, action == Action::"approve", resource) when { context has roles && context.roles.contains("payment-approver") };
@id("sod-blocks-approve")
@description("Separation of duties: nobody with a SoD conflict may approve, whatever other rules allow. The attribute is optional in the schema, so the rule guards its read with `has`.")
@pillar("sod")
forbid(principal, action == Action::"approve", resource) when { context has sod_conflict && context.sod_conflict == true };

// MCP sessions (AI access): the AI acts only inside its own data branch, authorized per call by this same
// engine, as the session owner. Requires the mcp-operator role from the ACTIVE version (main): a role the AI
// grants itself on its own branch has no effect until a human merges and activates it.
@id("mcp-operator-read-write-lifecycle")
@description("A person with the mcp-operator role may open MCP sessions that read, write and manage their own data branch.")
@pillar("mcp")
permit(principal, action in [Action::"mcp:read", Action::"mcp:write", Action::"mcp:lifecycle"], resource)
  when { context has roles && context.roles.contains("mcp-operator") };

// Relayed (proxy) tools additionally need a DELEGATION GRANT from the ACTIVE version (MCP gateway P2):
// the core injects the identity's unexpired grants as context.mcp_grants (UpstreamTool::"<upstream>__<tool>"),
// and the exact relayed tool must be one of them. A grant the AI writes on its own branch is not active
// until a human merges and activates it - same rule as roles.
@id("mcp-proxy-needs-delegation-grant")
@description("Relaying a tool through the MCP gateway requires the mcp-operator role and an active delegation grant on that exact tool.")
@pillar("mcp")
permit(principal, action == Action::"mcp:proxy", resource)
  when { context has roles && context.roles.contains("mcp-operator")
      && context has mcp_grants && context.mcp_grants.contains(resource) };

// Protected branches: merging a pull request into a protected branch needs the branch-merger role from the ACTIVE version (main).
@id("merge-into-protected-needs-branch-merger")
@description("A person holding the branch-merger role may merge a pull request into a protected branch such as main.")
@pillar("versioning")
permit(principal, action == Action::"branch:merge", resource)
  when { context has roles && context.roles.contains("branch-merger") };
