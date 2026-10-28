// Demo policies (fictional identities). forbid always wins over permit.
// Static demo rules apply only to requests WITHOUT tenant data (no context.tenant_mode).
permit(principal == User::"alice", action == Action::"approve", resource) unless { context has tenant_mode };
permit(principal == User::"bob",   action == Action::"read",    resource) unless { context has tenant_mode };
// Tenant mode: roles and sod_conflict are computed by the core from the ACTIVE data version, not supplied by the caller.
permit(principal, action == Action::"approve", resource) when { context has roles && context.roles.contains("payment-approver") };
forbid(principal, action == Action::"approve", resource) when { context.sod_conflict == true };
