// Demo policies (fictional identities). forbid always wins over permit.
// Static demo rules apply only to requests WITHOUT tenant data (no context.tenant_mode).
permit(principal == User::"alice", action == Action::"approve", resource) unless { context has tenant_mode };
// Tenant mode: roles and sod_conflict are computed by the core from the ACTIVE data version, not supplied by the caller.
permit(principal, action == Action::"approve", resource) when { context has roles && context.roles.contains("payment-approver") };
forbid(principal, action == Action::"approve", resource) when { context.sod_conflict == true };

// MCP sessions (AI access): the AI acts only inside its own data branch, authorized per call by this same
// engine, as the session owner. Requires the mcp-operator role from the ACTIVE version (main): a role the AI
// grants itself on its own branch has no effect until a human merges and activates it.
permit(principal, action in [Action::"mcp:read", Action::"mcp:write", Action::"mcp:lifecycle"], resource)
  when { context has roles && context.roles.contains("mcp-operator") };
