import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, MigrationJournal, readManifest } from './journal.js';

export function migrationPaths() {
  const root = resolve(process.env.IAM_MIGRATION_SOURCE_ROOT ?? process.cwd());
  const home = resolve(process.env.IAM_DEMO_HOME ?? '/data');
  const manifest = readManifest(root);
  return { root, home, manifest, journal: new MigrationJournal(home, manifest.versions.map(({ id, name, checksum }) => ({ id, name, checksum }))) };
}
function dolt(home: string, args: string[], input?: string) {
  const r = spawnSync(process.env.DOLT_BIN ?? 'dolt', args, { cwd: join(home, 'dolt'), input, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('Dolt migration read/write failed; no success recorded. Preserve data and inspect private logs.');
  return r.stdout;
}
/** Read-only full branch working-root fingerprints, including meta. Never check out or reset a branch. */
export function adoptionSnapshot(home: string) {
  const query = (db: string, sql: string) => {
    const v = JSON.parse(dolt(home, [...(db ? [`--use-db=${db}`] : []), 'sql', '-r', 'json', '-q', sql]));
    if (!Array.isArray(v.rows)) throw new Error('unexpected Dolt snapshot response');
    return v.rows as Record<string, unknown>[];
  };
  const dbs = query('', 'SHOW DATABASES').map(r => Object.values(r)[0]).filter(x => typeof x === 'string' && !['information_schema', 'mysql', 'dolt_cluster'].includes(x)).sort() as string[];
  if (!dbs.includes('iam')) throw new Error('existing iam database required for adoption');
  const branches = dbs.flatMap(db => query(db, 'SELECT name, hash FROM dolt_branches ORDER BY name').map(b => {
    if (typeof b.name !== 'string' || typeof b.hash !== 'string') throw new Error('invalid branch inventory');
    const roots = query(`${db}/${b.name}`, "SELECT DOLT_HASHOF_DB('WORKING') AS root");
    if (typeof roots[0]?.root !== 'string') throw new Error('missing working root');
    return { database: db, branch: b.name, head: b.hash, root: roots[0].root };
  }));
  for (const table of ['identities', 'assignments', 'roles', 'plugin_config', 'sod_rules', 'delegation_grants', 'workflow_definitions', 'policy_sets', 'policy_rules', 'policy_template_links', 'organizations', 'org_memberships', 'app_connectors']) {
    // Prove baseline schema, never infer it from a missing table or permission error.
    query('iam/main', `SELECT count(*) AS n FROM \`${table}\``);
  }
  query('iam/main', 'SELECT count(id), count(display_name), count(manager_id), count(department), count(email), count(login_enabled), count(credential_revision) FROM identities');
  return branches;
}

async function cli() {
  const [command, arg, backup] = process.argv.slice(2);
  const { root, home, manifest, journal } = migrationPaths();
  if (command === 'prepare') {
    const bootId = process.env.IAM_MIGRATION_BOOT_ID;
    if (!bootId || !['empty', 'populated'].includes(arg)) throw new Error('invalid boot context');
    const state = journal.read();
    if (state) { if (arg === 'empty') throw new Error('journal exists but dataset missing'); journal.assertBoot(bootId); return; }
    if (arg !== 'empty' || process.env.IAM_DEMO_SEED_MODE === 'never') throw new Error('existing data requires explicit baseline adoption; seed never is preserved');
    journal.initialize(); journal.begin('0001', bootId, 'initial-schema');
    dolt(home, ['sql'], readFileSync(join(root, 'data/migrations/0001-initial.sql'), 'utf8'));
    journal.phase(bootId, 'initial-api');
    return;
  }
  if (command === 'plan-adoption') {
    if (journal.read()) throw new Error('journal already exists');
    if (!arg || !backup || !readFileSync(backup).length) throw new Error('output plan and cold-backup manifest required');
    const plan = { format: 1, baseline: manifest.versions[0].checksum, createdAt: new Date().toISOString(), backupManifest: resolve(backup), backupSha256: hash(readFileSync(backup)), branches: adoptionSnapshot(home) };
    writeFileSync(arg, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Adoption PLAN only. Compare backup/evidence and every branch before explicit adopt. No data seeded or changed.'); return;
  }
  if (command === 'adopt-existing-v1') {
    if (!arg || !backup || backup !== '--confirm-reviewed-backup-and-existing-v1') throw new Error('reviewed plan and explicit confirmation required');
    const text = readFileSync(arg, 'utf8'), plan = JSON.parse(text);
    if (plan.format !== 1 || plan.baseline !== manifest.versions[0].checksum || !plan.backupManifest || !existsSync(plan.backupManifest) || hash(readFileSync(plan.backupManifest)) !== plan.backupSha256 || JSON.stringify(plan.branches) !== JSON.stringify(adoptionSnapshot(home))) throw new Error('adoption evidence drift or invalid backup manifest');
    journal.adopt(hash(text)); console.log('Baseline 0001 adopted without seeding. Business branches and data unchanged.'); return;
  }
  if (command === 'status') { console.log(JSON.stringify(journal.read() ?? { untracked: true }, null, 2)); return; }
  if (command === 'boot-id') { console.log(randomUUID()); return; }
  throw new Error('commands: prepare, status, plan-adoption <new-plan> <cold-backup-MANIFEST>, adopt-existing-v1 <reviewed-plan> --confirm-reviewed-backup-and-existing-v1');
}
if (process.argv[1]?.endsWith('/migrations/cli.js')) cli().catch(() => { console.error('[migrations] operation refused. Inventory/adoption/migration state is uncertain; keep the app stopped and preserve complete backups. No automatic reset or seed.'); process.exitCode = 1; });
