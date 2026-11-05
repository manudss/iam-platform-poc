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
INSERT IGNORE INTO identities VALUES ('demo-alice','Alice Demo',NULL,'finance'),('demo-bob','Bob Demo','demo-alice','finance');
INSERT IGNORE INTO roles VALUES ('accountant','Accountant',FALSE),('payment-approver','Payment approver',TRUE),('payment-creator','Payment creator',TRUE),('mcp-operator','MCP operator (AI sessions)',TRUE);
INSERT IGNORE INTO assignments VALUES ('demo-bob','payment-creator');
INSERT IGNORE INTO assignments VALUES ('demo-alice','mcp-operator');
INSERT IGNORE INTO sod_rules VALUES ('payment-creator','payment-approver');
-- Demo: demo-alice's AI sessions may READ the sandbox "fake" upstream (search/get), never write it (createIssue is not granted).
INSERT IGNORE INTO delegation_grants VALUES ('acme-demo','demo-alice','fake','searchIssues',NULL,'demo-seed'),('acme-demo','demo-alice','fake','getIssue',NULL,'demo-seed'),
-- demo-bob can SEE fake getIssue (grant) but has no mcp-operator role: proves Cedar is the last word, not the allowlist.
('acme-demo','demo-bob','fake','getIssue',NULL,'demo-seed');
CALL DOLT_ADD('-A');
CALL DOLT_COMMIT('-m','demo seed');
