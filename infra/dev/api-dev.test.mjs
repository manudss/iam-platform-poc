// Unit tests for the pure parts of the local API dev runner (infra/dev/api-dev.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

// Non-regression for the launcher scripts (scripts/dev.sh): the published-port preflight must
// only guard the way UP - `--down` has to stay usable exactly when a previous stack holds 4200.
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { createServer } from 'node:net';

const REPO = join(__dirname, '..', '..');
const PORTS = [4200, 3000, 8081, 3307, 5433, 7233, 4222, 8200];

function stubbedDocker(log) {
  const bin = mkdtempSync(join(tmpdir(), 'dev-sh-docker-'));
  const stub = join(bin, 'docker');
  writeFileSync(stub, '#!/bin/sh\necho "$@" >> "$STUB_LOG"\nexit 0\n');
  chmodSync(stub, 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, STUB_LOG: log };
}

function runDevSh(args, env, cwd = REPO) {
  return spawnSync('bash', ['scripts/dev.sh', ...args], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

function holdAnyPort(ports) {
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= ports.length) return resolve(null);
      const server = createServer();
      server.once('error', () => tryNext(i + 1));
      server.listen(ports[i], '127.0.0.1', () => resolve({
        port: ports[i],
        release: () => new Promise((res) => server.close(res)),
      }));
    };
    tryNext(0);
  });
}

test('dev.sh --down works while a previous stack still holds a published port', async (t) => {
  const held = await holdAnyPort(PORTS);
  if (!held) { t.skip('every published port is busy on this machine'); return; }
  const log = join(make(), 'docker.log');
  try {
    const down = runDevSh(['--down'], stubbedDocker(log));
    assert.equal(down.status, 0, `down must not be blocked by the port preflight: ${down.stderr}`);
    assert.match(readFileSync(log, 'utf8'), /compose .* down/, 'down reaches compose down');
  } finally { await held.release(); }
});

test('dev.sh up refuses a busy published port with a clear message, and starts once free', async (t) => {
  const held = await holdAnyPort(PORTS);
  if (!held) { t.skip('every published port is busy on this machine'); return; }
  const log = join(make(), 'docker.log');
  const up = runDevSh([], stubbedDocker(log));
  assert.equal(up.status, 1, 'a busy port blocks the up path');
  assert.match(up.stderr, /already in use/, 'the message names the cause');
  assert.ok(!existsSync(log) || !/up --build/.test(readFileSync(log, 'utf8')), 'compose up is never reached');
  await held.release();
  const log2 = join(make(), 'docker.log');
  const up2 = runDevSh([], stubbedDocker(log2));
  assert.equal(up2.status, 0, `free ports let the stack start: ${up2.stderr}`);
  assert.match(readFileSync(log2, 'utf8'), /compose .* up --build/, 'up reaches compose up --build');
});
