// Unit tests for the MCP confinement helpers: adversarial SQL against the skeleton-based guard, no server needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkMcpSql, TOOL_KINDS } from './tools.js';

describe('MCP SQL confinement (skeleton-based)', () => {
  const ok = (sql: string) => checkMcpSql(sql, 'read');
  const bad = (sql: string, mode: 'read' | 'write' = 'read') => assert.throws(() => checkMcpSql(sql, mode));

  it('plain business reads pass and expose their target tables', () => {
    assert.deepEqual(ok('select id, display_name from identities').tables, ['identities']);
    assert.deepEqual(ok('select * from assignments a join roles r on r.id = a.role_id').tables.sort(), ['assignments', 'roles']);
    assert.ok(ok('with x as (select * from identities) select * from x').tables.includes('identities'));
  });

  it('sensitive names are refused however they are reached: alias, CTE, subquery, quoted value, view target', () => {
    bad('select * from outbox');
    bad('select o.* from outbox o');
    bad('with leaked as (select * from outbox) select 1'); // CTE names it even when unused
    bad('select (select count(*) from outbox) from identities');
    bad('select credential_revision from identities');
    bad('select * from iam_meta.mcp_sessions');
    bad('select * from information_schema.tables');
    bad('create view v as select * from outbox', 'write'); // the write path is checked the same way, so no smuggled view can be created
    bad('update identities set credential_revision = null where id = \'demo-bob\'', 'write');
  });

  it('a literal that merely MENTIONS a sensitive word stays allowed (literals are emptied before matching)', () => {
    assert.deepEqual(ok("select * from identities where department = 'outbox team'").tables, ['identities']);
  });

  it('read mode keeps the console rules: exactly one statement, no writes, no version-control functions', () => {
    bad('select * from identities; select * from roles');
    bad('delete from identities');
    bad('call dolt_commit(\'-m\',\'x\')');
  });

  it('write mode keeps the console rules and adds MCP confinement', () => {
    assert.deepEqual(checkMcpSql("insert into roles values ('auditor','Auditor',false)", 'write').tables, ['roles']);
    assert.throws(() => checkMcpSql('create table user_tokens (id int)', 'write'), /token/i);
    assert.deepEqual(checkMcpSql('insert into plugin_config values (\'acme-demo\',\'mail\',true,\'{"note":"a token word in a literal"}\')', 'write').tables, ['plugin_config']); // literals are emptied: mentioning a sensitive word in a VALUE stays allowed
  });

  it('tool inventory: no approval, merge, close, apply, or branch-picking tool exists', () => {
    for (const t of Object.keys(TOOL_KINDS)) assert.ok(!/approve|merge|close|apply|delete_branch|checkout/i.test(t), t);
    assert.ok(Object.hasOwn(TOOL_KINDS, 'submit_pull_request'));
    assert.ok(Object.hasOwn(TOOL_KINDS, 'request_new_branch'));
    assert.ok(Object.hasOwn(TOOL_KINDS, 'rebase_on_main'));
  });
});
