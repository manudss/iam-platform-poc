import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorOf, branchName, checkSql, newBranchName, scanSql, tableName } from './guards.js';

const bad = (sql: string, mode: 'read' | 'write') => assert.throws(() => checkSql(sql, mode), /./s, `should refuse: ${sql}`);
const ok = (sql: string, mode: 'read' | 'write') => assert.doesNotThrow(() => checkSql(sql, mode), `should accept: ${sql}`);

describe('SQL console guard: read mode', () => {
  it('accepts plain reads and the read-only Dolt system tables and functions', () => {
    for (const s of ['select * from assignments', 'SHOW TABLES', 'describe roles', 'explain select 1', 'with x as (select 1) select * from x', 'select * from dolt_log limit 5',
      "select * from dolt_diff('main','b1','assignments')", "select * from dolt_diff_summary('main...b1')", 'select * from dolt_history_assignments', 'select * from dolt_branches',
      "select hashof('main')", 'select active_branch()', 'select * from dolt_conflicts_assignments', "select 'dolt_commit' as just_text", 'select 1; -- trailing comment']) ok(s, 'read');
  });
  it('refuses every way to write or to call version-control actions', () => {
    for (const s of ["call dolt_commit('-am','x')", "select dolt_commit('-am','x')", "select DOLT_MERGE('b1')", "select dolt_checkout('b1')", "select dolt_reset('--hard')", "select dolt_branch('x')", "select dolt_push('origin','main')",
      "select dolt_conflicts_resolve('--ours','t')", 'select * from `dolt_commit`(\'x\')', "select * from dolt_commit ('x')", 'insert into assignments values (1,2)', 'update roles set label=1', 'drop table roles', 'delete from roles', 'set @@autocommit=0',
      'use mysql', 'grant all on *.* to x', 'select * from mysql.user', 'select * from `mysql`.`user`', 'SELECT * FROM MYSQL . user', 'select (select count(*) from mysql.db)', 'show grants', 'show databases', 'show create user root', 'show processlist', 'show variables', 'select * from performance_schema.threads', 'select * from roles into outfile "/tmp/x"', 'select sleep(5)', 'select benchmark(100000000, md5(1))', 'select load_file("/etc/passwd")', 'select @@global.max_connections', 'select 1; select 2',
      '/*! select 1 */ select 2', 'select 1 /*+ x */', "select 'unterminated", 'select /* unterminated', '', '   ']) bad(s, 'read');
  });
  it('is not fooled by comments, quoting or case', () => {
    bad("sel/**/ect 1", 'read'); // splits the keyword: not a select
    bad('/* select */ drop table roles', 'read');
    bad('-- select\ndrop table roles', 'read');
    bad("select 1; call dolt_commit('-am','x')", 'read');
    bad('select * from `dolt_Commit_Ancestors_x`', 'read'); // unknown dolt_ table name: refused, only the listed read-only ones pass
    bad('select DoLt_ReVeRt(hashof(\'main\'))', 'read');
  });
});

const others = ['iam_meta'];
describe('cross-schema access', () => {
  it('refuses the pull request store and system schemas in both modes, accepts own table.column references', () => {
    assert.throws(() => checkSql('select * from iam_meta.pull_requests', 'read', others));
    assert.throws(() => checkSql("insert into iam_meta.pull_requests (id) values (1)", 'write', others));
    assert.throws(() => checkSql('drop table IAM_META.pr_comments', 'write', others));
    assert.throws(() => checkSql('insert into mysql.user values (1)', 'write', others));
    assert.throws(() => checkSql('create table mysql.x (id int)', 'write', others));
    assert.doesNotThrow(() => checkSql('select a.identity_id, r.label from assignments a join roles r on r.id = a.role_id', 'read', others));
    assert.doesNotThrow(() => checkSql('select * from iam.assignments', 'read', others));
  });
});

describe('SQL console guard: write mode', () => {
  it('accepts data and table changes, several statements', () => {
    for (const s of ["insert into assignments values ('a','b')", "update roles set label='x' where id='a'", "delete from roles where id='a'", 'create table t (id int primary key)', 'alter table t add column x int', 'rename table t to u',
      "insert into t values (1); insert into t values (2);", "replace into t values (1)"]) ok(s, 'write');
  });
  it('refuses reads, procedures, Dolt objects and anything outside tables', () => {
    for (const s of ['select 1', "call dolt_commit('-am','x')", "insert into dolt_ignore values ('x', true)", 'drop table dolt_ignore', 'update dolt_docs set doc_text = 1', 'drop database iam', 'create database x', 'create user x', 'grant all on *.* to x', 'set autocommit=1', 'truncate dolt_branches',
      "insert into t select dolt_commit('x')", 'insert into t values (@@version)', 'select * from t into outfile "x"']) bad(s, 'write');
  });
  it('flags destructive statements: DROP, TRUNCATE, ALTER DROP, UPDATE and DELETE without WHERE', () => {
    for (const s of ['drop table roles', 'truncate roles', 'alter table roles drop column label', 'delete from roles', 'update roles set label = null']) assert.equal(checkSql(s, 'write').destructive, true, s);
    for (const s of ["delete from roles where id = 'a'", "update roles set label = 'x' where id = 'a'", "insert into roles values ('a','b',false)", 'create table z (id int)']) assert.equal(checkSql(s, 'write').destructive, false, s);
  });
});

describe('scanSql', () => {
  it('splits on top-level semicolons only', () => {
    assert.deepEqual(scanSql("insert into t values ('a;b'); insert into t values (\"c;d\"); -- x; y\n select 1").statements.length, 3);
    assert.equal(scanSql('select 1;').statements.length, 1);
  });
  it('rejects oversize input', () => { assert.throws(() => scanSql('select ' + '1,'.repeat(11000) + '1')); });
});

describe('names', () => {
  it('validates branch, table and author names', () => {
    for (const n of ['main', 'change-0a1b2c3d', 'feature.x_y-1', 'team/a']) assert.equal(branchName(n), n);
    for (const n of ['', '-x', 'a b', 'a..b', "a'; drop", 'x/', 'a.lock', 'é', 'a'.repeat(64), 5, null]) assert.throws(() => branchName(n), /./s, String(n));
    assert.equal(newBranchName('team/a'), 'team/a'); assert.throws(() => newBranchName('a/b/c')); assert.throws(() => newBranchName('/a'));
    assert.equal(newBranchName('fix-1'), 'fix-1');
    assert.throws(() => tableName('a;b')); assert.throws(() => tableName('`x`')); assert.equal(tableName('plugin_config'), 'plugin_config');
    assert.equal(authorOf('demo-alice'), 'demo-alice <demo-alice@iam-poc.invalid>');
    assert.equal(authorOf("x'<script>"), 'xscript <xscript@iam-poc.invalid>');
    assert.equal(authorOf(undefined), 'unknown <unknown@iam-poc.invalid>');
  });
});
