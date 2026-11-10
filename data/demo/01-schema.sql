-- Demo business data for Dolt. Fictional identities only, no secrets.
CREATE DATABASE IF NOT EXISTS iam;
USE iam;
CREATE TABLE IF NOT EXISTS identities (id VARCHAR(32) PRIMARY KEY, display_name VARCHAR(80), manager_id VARCHAR(32), department VARCHAR(40));
CREATE TABLE IF NOT EXISTS roles (id VARCHAR(32) PRIMARY KEY, label VARCHAR(80), is_sensitive BOOLEAN DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS assignments (identity_id VARCHAR(32), role_id VARCHAR(32), PRIMARY KEY (identity_id, role_id));
-- Plugin configuration versioned like business data (non-secret settings only; secrets never go to Dolt).
CREATE TABLE IF NOT EXISTS plugin_config (tenant VARCHAR(32), plugin VARCHAR(64), enabled BOOLEAN NOT NULL DEFAULT FALSE, settings JSON NOT NULL, PRIMARY KEY (tenant, plugin));
CREATE TABLE IF NOT EXISTS sod_rules (role_a VARCHAR(32), role_b VARCHAR(32), PRIMARY KEY (role_a, role_b));
-- Delegation grants (MCP gateway P2): which identity may invoke which tool of which relayed MCP upstream.
-- Versioned like roles: a change has no effect until a human merges it into main and the commit is activated.
CREATE TABLE IF NOT EXISTS delegation_grants (tenant VARCHAR(32) NOT NULL, identity_id VARCHAR(64) NOT NULL, upstream VARCHAR(40) NOT NULL, tool VARCHAR(64) NOT NULL, expires_at DATETIME(3) NULL, granted_by VARCHAR(64) NOT NULL, PRIMARY KEY (tenant, identity_id, upstream, tool));
-- Workflow definitions are configuration, versioned like the rest (runs and steps stay in the unversioned meta database).
CREATE TABLE IF NOT EXISTS workflow_definitions (tenant VARCHAR(32) NOT NULL, id VARCHAR(40) NOT NULL, name VARCHAR(80) NOT NULL, description VARCHAR(500) NOT NULL, graph JSON NOT NULL, trigger_json JSON NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, PRIMARY KEY (tenant, id));
-- Policy studio (step 4): the Cedar rules are business data, versioned like roles. Several named sets,
-- each rule one row (its Cedar text with its annotations); a template link is data, one row per beneficiary.
-- Empty tables = no rules in the activation snapshot: the core falls back to its boot file (jeu de secours).
CREATE TABLE IF NOT EXISTS policy_sets (name VARCHAR(32) PRIMARY KEY, description VARCHAR(200));
CREATE TABLE IF NOT EXISTS policy_rules (set_name VARCHAR(32) NOT NULL, id VARCHAR(64) NOT NULL, cedar TEXT NOT NULL, PRIMARY KEY (set_name, id));
CREATE TABLE IF NOT EXISTS policy_template_links (id VARCHAR(64) PRIMARY KEY, template_id VARCHAR(64) NOT NULL, principal_value VARCHAR(80) NULL, resource_value VARCHAR(80) NULL);
INSERT IGNORE INTO identities VALUES ('demo-alice','Alice Demo',NULL,'finance'),('demo-bob','Bob Demo','demo-alice','finance');
INSERT IGNORE INTO roles VALUES ('accountant','Accountant',FALSE),('payment-approver','Payment approver',TRUE),('payment-creator','Payment creator',TRUE),('mcp-operator','MCP operator (AI sessions)',TRUE),('branch-merger','Branch merger (merge into protected branches)',FALSE),('iam-admin','IAM administrator',FALSE),('manager','Manager (merges profile/ branches)',FALSE),('main-merger','Main merger (merges into main only)',FALSE);
INSERT IGNORE INTO assignments VALUES ('demo-bob','payment-creator');
INSERT IGNORE INTO assignments VALUES ('demo-alice','mcp-operator'),('demo-alice','branch-merger');
INSERT IGNORE INTO sod_rules VALUES ('payment-creator','payment-approver');
-- Demo: demo-alice's AI sessions may READ the sandbox "fake" upstream (search/get), never write it (createIssue is not granted).
INSERT IGNORE INTO delegation_grants VALUES ('acme-demo','demo-alice','fake','searchIssues',NULL,'demo-seed'),('acme-demo','demo-alice','fake','getIssue',NULL,'demo-seed'),
-- demo-bob can SEE fake getIssue (grant) but has no mcp-operator role: proves Cedar is the last word, not the allowlist.
('acme-demo','demo-bob','fake','getIssue',NULL,'demo-seed');
-- P3 (real Jira): when the Atlassian Rovo MCP is registered as upstream "jira", demo-alice's AI sessions may READ it
-- (search/get/list + the account introspection tools). Write tools (createJiraIssue, ...) stay ungranted until a human
-- merges a grant - "read-only first, write behind approval". The discover/execute* meta-tools are NEVER seeded:
-- they would let the agent reach the whole catalog around the per-tool allowlist.
INSERT IGNORE INTO delegation_grants VALUES
('acme-demo','demo-alice','jira','atlassianUserInfo',NULL,'demo-seed'),
('acme-demo','demo-alice','jira','getAccessibleAtlassianResources',NULL,'demo-seed'),
('acme-demo','demo-alice','jira','searchJiraIssuesUsingJql',NULL,'demo-seed'),
('acme-demo','demo-alice','jira','getJiraIssue',NULL,'demo-seed'),
('acme-demo','demo-alice','jira','listJiraProjects',NULL,'demo-seed'),
('acme-demo','demo-alice','jira','listJiraIssueComments',NULL,'demo-seed');
INSERT IGNORE INTO policy_sets VALUES ('default','Demo rules - the same content as the boot file policies/demo.cedar, so a fresh demo behaves identically with or without activation.');
INSERT IGNORE INTO policy_rules VALUES
('default','demo-alice-approves','@id("demo-alice-approves")\n@description("Demo identity alice may approve (only for requests without tenant data).")\n@pillar("human")\npermit(principal == User::"alice", action == Action::"approve", resource) unless { context has tenant_mode };'),
('default','demo-bob-reads','@id("demo-bob-reads")\n@description("Demo identity bob may read (only for requests without tenant data).")\n@pillar("human")\npermit(principal == User::"bob",   action == Action::"read",    resource) unless { context has tenant_mode };'),
('default','approve-needs-payment-approver','@id("approve-needs-payment-approver")\n@description("A person holding the payment-approver role may approve.")\n@pillar("human")\npermit(principal, action == Action::"approve", resource) when { context has roles && context.roles.contains("payment-approver") };'),
('default','sod-blocks-approve','@id("sod-blocks-approve")\n@description("Separation of duties: nobody with a SoD conflict may approve, whatever other rules allow. The attribute is optional in the schema, so the rule guards its read with `has`.")\n@pillar("sod")\nforbid(principal, action == Action::"approve", resource) when { context has sod_conflict && context.sod_conflict == true };'),
('default','mcp-operator-read-write-lifecycle','@id("mcp-operator-read-write-lifecycle")\n@description("A person with the mcp-operator role may open MCP sessions that read, write and manage their own data branch.")\n@pillar("mcp")\npermit(principal, action in [Action::"mcp:read", Action::"mcp:write", Action::"mcp:lifecycle"], resource)\n  when { context has roles && context.roles.contains("mcp-operator") };'),
('default','mcp-proxy-needs-delegation-grant','@id("mcp-proxy-needs-delegation-grant")\n@description("Relaying a tool through the MCP gateway requires the mcp-operator role and an active delegation grant on that exact tool.")\n@pillar("mcp")\npermit(principal, action == Action::"mcp:proxy", resource)\n  when { context has roles && context.roles.contains("mcp-operator")\n      && context has mcp_grants && context.mcp_grants.contains(resource) };'),
('default','merge-into-protected-needs-branch-merger','@id("merge-into-protected-needs-branch-merger")\n@description("A person holding the iam-admin or branch-merger role may merge a pull request into a protected branch such as main.")\n@pillar("versioning")\npermit(principal, action == Action::"branch:merge", resource)\n  when { context has roles && (context.roles.contains("branch-merger") || context.roles.contains("iam-admin")) };'),
('default','merge-profile-branches-into-protected','@id("merge-profile-branches-into-protected")\n@description("A manager may merge profile/ branches (profile changes) into a protected branch such as main, and no other kind of branch.")\n@pillar("versioning")\npermit(principal, action == Action::"branch:merge", resource)\n  when { context has roles && context.roles.contains("manager") && context has source_kind && context.source_kind == "profile" };'),
('default','merge-into-main-needs-main-merger','@id("merge-into-main-needs-main-merger")\n@description("A person holding the main-merger role may merge a pull request into main, and into no other protected branch.")\n@pillar("versioning")\npermit(principal, action == Action::"branch:merge", resource == Branch::"main")\n  when { context has roles && context.roles.contains("main-merger") };');
CALL DOLT_ADD('-A');
CALL DOLT_COMMIT('-m','demo seed');
