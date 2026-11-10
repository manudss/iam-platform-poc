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

// Protected branches: merging a pull request into a protected branch needs the iam-admin or branch-merger role from the ACTIVE version (main).
@id("merge-into-protected-needs-branch-merger")
@description("A person holding the iam-admin or branch-merger role may merge a pull request into a protected branch such as main.")
@pillar("versioning")
permit(principal, action == Action::"branch:merge", resource)
  when { context has roles && (context.roles.contains("branch-merger") || context.roles.contains("iam-admin")) };

@id("main-profile-merger")
@description("A manager may merge profile/ branches (profile changes) into main, and no other kind of branch.")
@pillar("versioning")
permit(principal, action == Action::"branch:merge", resource == Branch::"main")
  when { context has roles && context.roles.contains("manager") && context has source_kind && context.source_kind == "profile" };

@id("merge-into-main-needs-main-merger")
@description("A person holding the main-merger role may merge a pull request into main, and into no other protected branch.")
@pillar("versioning")
permit(principal, action == Action::"branch:merge", resource == Branch::"main")
  when { context has roles && context.roles.contains("main-merger") };

@id("main-scoped-assignments-merger")
@description("A manager or an organisation admin may merge into main ONLY their own personal branch, and only when it touches assignments of people in their scope (checked row by row from the real diff).")
@pillar("access")
permit(principal, action == Action::"branch:merge", resource == Branch::"main")
  when { context has roles && (context.roles.contains("manager") || context.roles.contains("org-admin")) && context has own_branch && context.own_branch == true && context has change_scope && context.change_scope == "assignments-in-scope" };

// Screen access and people scopes (access pillar): who opens which admin screen, and which people a manager or an organisation admin may read, manage or assign roles to.

@id("screen-iam-admin")
@description("The super admin role opens every screen.")
@pillar("access")
permit(principal, action == Action::"screen:open", resource)
  when { context has roles && context.roles.contains("iam-admin") };

@id("screen-people-admin")
@description("Managers and organisation admins open Users, Profile reviews and Assignments & changes.")
@pillar("access")
permit(principal, action == Action::"screen:open", resource)
  when { resource in [Screen::"users", Screen::"profile-reviews", Screen::"assignments"] && context has roles && (context.roles.contains("manager") || context.roles.contains("org-admin")) };

@id("screen-branch-governance")
@description("Merge and branch governance roles open Pull requests, Compare, History and Branches, never Data, SQL or configuration.")
@pillar("access")
permit(principal, action == Action::"screen:open", resource)
  when { resource in [Screen::"dolt-pulls", Screen::"dolt-compare", Screen::"dolt-history", Screen::"dolt-branches"] && context has roles && (context.roles.contains("main-merger") || context.roles.contains("branch-merger")) };

@id("screen-my-profile")
@description("Everyone signed in opens their own profile.")
@pillar("access")
permit(principal, action == Action::"screen:open", resource == Screen::"my-profile");

@id("user-iam-admin")
@description("The super admin reads and manages every person.")
@pillar("access")
permit(principal, action in [Action::"user:read", Action::"user:manage", Action::"assignment:change"], resource)
  when { context has roles && context.roles.contains("iam-admin") };

@id("user-scope-manager-chain")
@description("A manager reads and manages the people below them in the manager chain (reports, recursively), never themselves.")
@pillar("access")
permit(principal, action in [Action::"user:read", Action::"user:manage"], resource)
  when { context has roles && context.roles.contains("manager") && resource in principal && resource != principal };

@id("user-scope-organisation")
@description("An organisation admin reads and manages the people of their organisations and the organisations below, never themselves.")
@pillar("access")
permit(principal, action in [Action::"user:read", Action::"user:manage"], resource)
  when { context has roles && context.roles.contains("org-admin") && context has admin_orgs && resource in context.admin_orgs && resource != principal };

@id("assignment-manager-chain")
@description("A manager may assign or remove an allowed role for the people below them in the manager chain.")
@pillar("access")
permit(principal, action == Action::"assignment:change", resource)
  when { context has roles && context.roles.contains("manager") && resource in principal && resource != principal && context has role && ["accountant", "payment-creator", "employee", "hr-partner", "sales-rep"].contains(context.role) };

@id("assignment-organisation")
@description("An organisation admin may assign or remove an allowed role for the people of their organisations.")
@pillar("access")
permit(principal, action == Action::"assignment:change", resource)
  when { context has roles && context.roles.contains("org-admin") && context has admin_orgs && resource in context.admin_orgs && resource != principal && context has role && ["accountant", "payment-creator", "employee", "hr-partner", "sales-rep"].contains(context.role) };

@id("assignment-no-escalation")
@description("Nobody but the super admin assigns a role that carries authority over rights.")
@pillar("access")
forbid(principal, action == Action::"assignment:change", resource)
  when { context has role && ["iam-admin", "main-merger", "branch-merger", "manager", "org-admin", "payment-approver"].contains(context.role) && !(context has roles && context.roles.contains("iam-admin")) };
