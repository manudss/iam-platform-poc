// Demo policies (fictional identities). forbid always wins over permit.
permit(principal == User::"alice", action == Action::"approve", resource);
permit(principal == User::"bob",   action == Action::"read",    resource);
forbid(principal, action == Action::"approve", resource) when { context.sod_conflict == true };
