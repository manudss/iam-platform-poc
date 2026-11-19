// Contract of demo/dolt-state.mjs: the seed guard. "empty" only ever means Dolt positively said
// the database/table is absent; every other failure is unreadable and must fail closed (exit 2,
// no stdout word) so start.sh refuses to boot instead of re-seeding over real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './dolt-state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'dolt-state.mjs');

test('classify: exit 0 means populated, even with 0 rows', () => {
  assert.equal(classify({ status: 0, stdout: '| n |\n| 0 |\n', stderr: '' }), 'populated');
});

test('classify: a genuine "not found" means empty', () => {
  assert.equal(classify({ status: 1, stdout: '', stderr: 'database not found: iam' }), 'empty');
  assert.equal(classify({ status: 1, stdout: '', stderr: 'table not found: assignments' }), 'empty');
  assert.equal(classify({ status: 1, stdout: 'error on line 1 for query: table does not exist', stderr: '' }), 'empty');
});

test('classify: any other failure throws (unreadable, never empty)', () => {
  for (const bad of [
    { status: 1, stdout: '', stderr: 'dolt repo is corrupted: chunk hash mismatch' },
    { status: 1, stdout: '', stderr: 'lock file is held by another process' },
    { status: null, stdout: '', stderr: '', error: new Error('spawn dolt ENOENT') },
    { status: 137, stdout: '', stderr: '' },
  ]) {
    assert.throws(() => classify(bad));
  }
});

/** Runs the real script against a stub `dolt` binary. */
const withStubDolt = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'dolt-state-'));
  const bin = join(dir, 'dolt');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return spawnSync('node', [script, '--dolt', bin, '--dir', dir], { encoding: 'utf8' });
};

test('script: prints populated and exits 0 when dolt answers', () => {
  const r = withStubDolt('echo "| n |"; echo "| 3 |"; exit 0');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'populated');
});

test('script: prints empty and exits 0 only on a not-found answer', () => {
  const r = withStubDolt('echo "database not found: iam" >&2; exit 1');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'empty');
});

test('script: fails closed (exit 2, no verdict) on an unexpected dolt error', () => {
  const r = withStubDolt('echo "permission denied reading .dolt" >&2; exit 1');
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /dolt state check failed/);
});

test('script: fails closed when the dolt binary is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dolt-state-'));
  const r = spawnSync('node', [script, '--dolt', join(dir, 'no-such-binary'), '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), '');
});
