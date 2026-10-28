-- Demo business data for Dolt. Fictional identities only, no secrets.
CREATE DATABASE IF NOT EXISTS iam;
USE iam;
CREATE TABLE IF NOT EXISTS identities (id VARCHAR(32) PRIMARY KEY, display_name VARCHAR(80), manager_id VARCHAR(32), department VARCHAR(40));
CREATE TABLE IF NOT EXISTS roles (id VARCHAR(32) PRIMARY KEY, label VARCHAR(80), is_sensitive BOOLEAN DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS assignments (identity_id VARCHAR(32), role_id VARCHAR(32), PRIMARY KEY (identity_id, role_id));
-- Plugin configuration versioned like business data (non-secret settings only; secrets never go to Dolt).
CREATE TABLE IF NOT EXISTS plugin_config (tenant VARCHAR(32), plugin VARCHAR(64), enabled BOOLEAN NOT NULL DEFAULT FALSE, settings JSON NOT NULL, PRIMARY KEY (tenant, plugin));
CREATE TABLE IF NOT EXISTS sod_rules (role_a VARCHAR(32), role_b VARCHAR(32), PRIMARY KEY (role_a, role_b));
INSERT IGNORE INTO identities VALUES ('demo-alice','Alice Demo',NULL,'finance'),('demo-bob','Bob Demo','demo-alice','finance');
INSERT IGNORE INTO roles VALUES ('accountant','Accountant',FALSE),('payment-approver','Payment approver',TRUE),('payment-creator','Payment creator',TRUE);
INSERT IGNORE INTO assignments VALUES ('demo-bob','payment-creator');
INSERT IGNORE INTO sod_rules VALUES ('payment-creator','payment-approver');
CALL DOLT_ADD('-A');
CALL DOLT_COMMIT('-m','demo seed');
