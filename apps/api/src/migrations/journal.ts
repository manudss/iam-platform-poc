import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface MigrationSpec { id: string; name: string; checksum: string }
export interface Entry extends MigrationSpec { completedAt: string; disposition: 'applied' | 'adopted'; evidence?: string }
export interface Journal { format: 1; entries: Entry[]; pending?: { id: string; bootId: string; phase: string; startedAt: string } }
export interface Manifest { format: 1; versions: (MigrationSpec & { files: Record<string, string> })[] }
export const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function error(msg: string): never { throw new Error(`[migrations] ${msg}; startup refused, data must be preserved`); }
export function readManifest(root: string): Manifest {
  const m = JSON.parse(readFileSync(join(root, 'data/migrations/manifest.json'), 'utf8')) as Manifest;
  if (m.format !== 1 || !Array.isArray(m.versions) || !m.versions.length) error('invalid manifest');
  let previous = 0;
  for (const v of m.versions) {
    if (!/^\d{4}$/.test(v.id) || Number(v.id) !== previous + 1 || !v.name || !v.files || !Object.keys(v.files).length) error('unordered or incomplete manifest');
    for (const [file, digest] of Object.entries(v.files)) {
      if (resolve(root, file) !== join(resolve(root), file) || file.startsWith('/') || file.includes('..') || !/^[0-9a-f]{64}$/.test(digest)) error('invalid manifest path/checksum');
      if (hash(readFileSync(join(root, file))) !== digest) error(`source checksum mismatch for version ${v.id}`);
    }
    if (v.checksum !== hash(JSON.stringify(v.files))) error(`manifest checksum mismatch for ${v.id}`);
    previous++;
  }
  return m;
}
/** Journal stays in the backed-up data volume, never in an image, branch or RAM fallback. */
export class MigrationJournal {
  readonly file: string;
  constructor(readonly home: string, readonly versions: MigrationSpec[]) { this.file = join(home, 'migrations', 'journal.json'); }
  read(): Journal | undefined {
    if (!existsSync(this.file)) return undefined;
    let j: Journal;
    try { j = JSON.parse(readFileSync(this.file, 'utf8')); } catch { return error('unreadable journal'); }
    if (j.format !== 1 || !Array.isArray(j.entries) || j.entries.length > this.versions.length) error('unknown journal version or newer database');
    for (let i = 0; i < j.entries.length; i++) {
      const expected = this.versions[i], e = j.entries[i];
      if (!expected || e.id !== expected.id || e.checksum !== expected.checksum || !e.completedAt || !['applied', 'adopted'].includes(e.disposition)) error('migration history gap or checksum drift');
    }
    if (j.pending && (j.pending.id !== this.versions[j.entries.length]?.id || typeof j.pending.bootId !== 'string' || !j.pending.phase || !j.pending.startedAt)) error('invalid pending migration');
    return j;
  }
  save(j: Journal) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(j, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const dir = openSync(dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  initialize() { if (this.read()) error('journal already exists'); this.save({ format: 1, entries: [] }); }
  begin(id: string, bootId: string, phase: string) {
    const j = this.read();
    if (!j || j.pending || this.versions[j.entries.length]?.id !== id || !bootId) error('cannot begin migration');
    j.pending = { id, bootId, phase, startedAt: new Date().toISOString() }; this.save(j);
  }
  phase(bootId: string, phase: string) {
    const j = this.read(); if (!j?.pending || j.pending.bootId !== bootId) error('interrupted or foreign boot');
    j.pending.phase = phase; this.save(j);
  }
  complete(bootId: string) {
    const j = this.read(); if (!j?.pending || j.pending.bootId !== bootId) error('interrupted or foreign boot');
    const spec = this.versions[j.entries.length];
    j.entries.push({ ...spec, completedAt: new Date().toISOString(), disposition: 'applied' }); delete j.pending; this.save(j);
  }
  adopt(evidence: string) {
    if (this.read() || !/^[0-9a-f]{64}$/.test(evidence)) error('adoption requires a new journal and verified evidence');
    this.save({ format: 1, entries: [{ ...this.versions[0], completedAt: new Date().toISOString(), disposition: 'adopted', evidence }] });
  }
  assertBoot(bootId: string) {
    const j = this.read(); if (!j) error('existing data needs explicit baseline adoption');
    if (j.pending && j.pending.bootId !== bootId) error(`interrupted migration ${j.pending.id}, phase ${j.pending.phase}; restore the complete pre-update backup or perform reviewed recovery, never delete the pending marker`);
    return j;
  }
}

/** Run in order, exactly once. Any uncertainty retains pending and blocks serving traffic. No automatic retry/reset. */
export async function migrate(journal: MigrationJournal, bootId: string, actions: { id: string; preflight?: () => Promise<void>; run: () => Promise<void>; verify: () => Promise<void> }[]) {
  let j = journal.assertBoot(bootId);
  if (j.pending && j.pending.id !== '0001') error('unexpected in-progress migration');
  for (let i = j.entries.length; i < journal.versions.length; i++) {
    const v = journal.versions[i], action = actions.find(a => a.id === v.id);
    if (!action) error(`missing implementation for ${v.id}`);
    // A refusal here happens BEFORE the pending marker exists: the data is untouched and the previous image can start again.
    if (!j.pending) { await action.preflight?.(); journal.begin(v.id, bootId, 'apply'); }
    await action.run();
    journal.phase(bootId, 'verify'); await action.verify(); journal.complete(bootId);
    j = journal.assertBoot(bootId);
  }
}
