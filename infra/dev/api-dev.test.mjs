// Unit tests for the pure parts of the local API dev runner (infra/dev/api-dev.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestMtimeMs, installStampStale } from './api-dev.mjs';

const make = () => mkdtempSync(join(tmpdir(), 'api-dev-'));

test('latestMtimeMs tracks the newest watched file and detects a later change', () => {
  const dir = make();
  try {
    mkdirSync(join(dir, 'src'));
    const a = join(dir, 'src', 'a.ts');
    writeFileSync(a, 'a');
    const past = new Date(Date.now() - 60_000);
    utimesSync(a, past, past);
    const first = latestMtimeMs([dir]);
    assert.ok(first > 0 && first <= Date.now() - 50_000, 'old file, old snapshot');
    writeFileSync(a, 'changed');
    assert.ok(latestMtimeMs([dir]) > first, 'a save moves the snapshot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('latestMtimeMs ignores build outputs and plugin signatures (no restart loop on own writes)', () => {
  const dir = make();
  try {
    for (const d of ['node_modules/x', 'dist', '.git', 'plugins/auth-password']) mkdirSync(join(dir, d), { recursive: true });
    const past = new Date(Date.now() - 60_000);
    const real = join(dir, 'plugins', 'auth-password', 'handlers.mjs');
    writeFileSync(real, 'x');
    utimesSync(real, past, past);
    for (const f of ['node_modules/x/index.js', 'dist/main.js', '.git/HEAD', 'plugins/auth-password/signature.json']) writeFileSync(join(dir, f), 'x');
    assert.equal(latestMtimeMs([dir]), statSync(real).mtimeMs, 'only the real source counts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installStampStale: missing lockfile or stamp means stale, identical stamp is fresh', () => {
  const dir = make();
  try {
    assert.equal(installStampStale(dir), true, 'no lockfile at all');
    writeFileSync(join(dir, 'package-lock.json'), 'LOCK');
    assert.equal(installStampStale(dir), true, 'no stamp yet');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', '.dev-install-stamp'), 'LOCK');
    assert.equal(installStampStale(dir), false, 'stamp matches the lockfile');
    writeFileSync(join(dir, 'package-lock.json'), 'LOCK2');
    assert.equal(installStampStale(dir), true, 'lockfile changed after the install');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
