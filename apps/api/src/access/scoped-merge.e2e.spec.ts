// Scoped assignments merge with REAL Dolt + the REAL Rust core + the real BranchProtectionService: a manager may merge into main a branch that only touches
// assignments of people in their management chain, with an allowed role. One foreign row refuses everything and the message names it.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { Test } from '@nestjs/testing';
import { ActivationService } from '../activation/activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';
import { VersioningModule } from '../versioning/versioning.module.js';
import { filterPeople } from './scope.js';
import { BranchProtectionService } from '../versioning/branch-protection.service.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(coreBin) && existsSync(doltBin);
const CORE = 'http://127.0.0.1:18095', ADMIN = 'local-demo-admin-token', PORT = 13327;

describe('scoped assignments merge: real Dolt + real core', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess, dir: string, prot: BranchProtectionService;
  const T = 'acme-demo';
  const conn = () => createConnection({ host: '127.0.0.1', port: PORT, user: 'root', database: 'iam', multipleStatements: false });
  /** A branch from main holding the given statements, committed; back on main afterwards (one session). */
  const branch = async (name: string, stmts: string[], owner = 'lucie-t') => {
    const m = await createConnection({ host: '127.0.0.1', port: PORT, user: 'root', multipleStatements: false });
    try {
      await m.query('create database if not exists iam_meta'); await m.query('use iam_meta');
      await m.query('create table if not exists personal_branches (tenant varchar(32) not null, sub varchar(64) not null, branch varchar(63) not null, created_at datetime(3) not null, last_seen_at datetime(3) not null, primary key (tenant, sub), unique key personal_branch_name (tenant, branch))');
      await m.query('replace into personal_branches values (?,?,?,now(3),now(3))', [T, owner, name]);
    } finally { await m.end(); }
    const c = await conn();
    try {
      await c.query("call dolt_checkout('main')"); await c.query("call dolt_checkout('-b', ?)", [name]);
      for (const s of stmts) await c.query(s);
      await c.query("call dolt_commit('-Am', ?)", [`change ${name}`]); await c.query("call dolt_checkout('main')");
    } finally { await c.end(); }
  };
  const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return JSON.stringify((e as { getResponse?: () => unknown }).getResponse?.() ?? String(e)); } assert.fail('expected a refusal'); };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-sm-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 150)); }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), stdio: 'ignore', env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18095', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN } });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN, DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_SCREEN_ACCESS: '1', IAM_TENANT: T });
    delete process.env.IAM_PG_URL;
    const c = await conn();
    try {
      await c.query("insert into identities (id, display_name, manager_id, department) values ('lucie-t','Lucie','', 'hr'),('yanis-t','Yanis','lucie-t','it'),('camille-t','Camille',null,'it'),('noemie-t','Noemie',null,'it')".replace("'',", 'null,'));
      await c.query("insert into assignments values ('lucie-t','manager'),('noemie-t','main-merger'),('alice-t','iam-admin')");
      await c.query("call dolt_commit('-Am', 'test world')");
    } finally { await c.end(); }
    await new ActivationService(undefined, new DoltService()).activate(T, await new DoltService().head(), 'req-scoped-0001');
    const m = await Test.createTestingModule({ imports: [VersioningModule] }).compile();
    prot = m.get(BranchProtectionService); await prot.onModuleInit();
  });
  after(async () => { core?.kill(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('a manager merges a change limited to assignments of her reports, with an allowed role', async () => {
    await branch('feature/ok', ["insert into assignments values ('yanis-t','payment-creator')"]);
    await prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/ok');
  });
  it('a manager may NOT merge a branch that is not her own, even when every row is in her scope', async () => {
    await branch('feature/someone-else', ["insert into assignments values ('yanis-t','employee')"], 'noemie-t');
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/someone-else')), /your own personal branch/);
    await branch('feature/unregistered', ["insert into assignments values ('yanis-t','employee')"], 'camille-t');
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/unregistered')), /your own personal branch/);
  });
  it('one foreign row refuses the whole merge and the message names the row', async () => {
    await branch('feature/foreign', ["insert into assignments values ('yanis-t','accountant'),('camille-t','accountant')"]);
    const m = await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/foreign'));
    assert.match(m, /camille-t/); assert.match(m, /accountant/);
  });
  it('an escalation role is refused even for her own report', async () => {
    await branch('feature/escalate', ["insert into assignments values ('yanis-t','iam-admin')"]);
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/escalate')), /iam-admin/);
    await branch('feature/escalate2', ["insert into assignments values ('yanis-t','manager')"]);
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/escalate2')), /manager/);
  });
  it('a role managers may not give is named as such, not blamed on the person', async () => {
    await branch('feature/analyst', ["insert into assignments values ('yanis-t','security-analyst')"]);
    const m = await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/analyst'));
    assert.match(m, /security-analyst/); assert.match(m, /managers may not give the role security-analyst/); assert.doesNotMatch(m, /not one of the people you manage/);
  });
  it('a diff that touches anything else than assignments is refused', async () => {
    await branch('feature/other', ["insert into assignments values ('yanis-t','employee')", "update identities set department='hr' where id='yanis-t'"]);
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/other')), /identities/);
  });
  it('removing a role of a report is in scope; removing one of someone else is not', async () => {
    await branch('feature/rm-foreign', ["delete from assignments where identity_id='noemie-t'"]);
    assert.match(await refusal(prot.assertMayMerge('main', 'lucie-t', 'merge into', 'feature/rm-foreign')), /noemie-t/);
  });
  it('Noemie (main-merger only) and Bob are not super admins: the scope rule does not give them more, and the main-merger right still holds', async () => {
    await prot.assertMayMerge('main', 'noemie-t', 'merge into', 'feature/foreign'); // main-merger rule: any source into main
    assert.match(await refusal(prot.assertMayMerge('main', 'bob-t', 'merge into', 'feature/ok')), /not allowed/i);
    await prot.assertMayMerge('main', 'alice-t', 'merge into', 'feature/foreign');
  });
  it('lists are filtered per person: Lucie sees her chain only, Alice sees everyone, Bob nobody', async () => {
    const rows = ['lucie-t', 'yanis-t', 'camille-t', 'noemie-t'].map((id) => ({ identity_id: id }));
    const ids = async (who: string) => (await filterPeople(T, who, 'user:read', rows, (r) => r.identity_id)).map((r) => r.identity_id);
    assert.deepEqual(await ids('lucie-t'), ['yanis-t']);
    assert.equal((await ids('alice-t')).length, 4);
    assert.deepEqual(await ids('bob-t'), []);
  });
});
