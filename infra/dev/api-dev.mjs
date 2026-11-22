// Local development runner for the API, inside the app container of infra/docker-compose.dev.yml
// (started by infra/dev/app-dev.sh after the Rust core; the core<->API gate is loopback-only by
// design, hence one container). NOT for production.
//  1. waits for Dolt, NATS and the Rust core (the first core build takes several minutes),
//  2. installs the npm dependencies once per lockfile change (named volumes keep them between runs),
//  3. compiles the API, starts it, then recompiles and restarts it when apps/api/src or plugins change.
// File watching POLLS: bind mounts from Windows/macOS deliver no fs events inside a container.
import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const API = join(REPO, 'apps', 'api');
const WATCHED = [join(API, 'src'), join(REPO, 'plugins')];
const IGNORED_NAMES = new Set(['node_modules', 'dist', '.git', '.angular', 'target', 'signature.json']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[api-dev] ${msg}`);

/** Newest mtime (ms) under the given roots; ignored directories/files above are skipped. 0 when empty. */
export function latestMtimeMs(roots) {
  let latest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORED_NAMES.has(e.name)) continue;
      const p = join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else { const m = statSync(p).mtimeMs; if (m > latest) latest = m; }
      } catch { /* file vanished mid-scan */ }
    }
  };
  for (const r of roots) walk(r);
  return latest;
}

/** npm ci is replayed only when the lockfile changed since the last install (stamp inside node_modules). */
export function installStampStale(dir) {
  const lock = join(dir, 'package-lock.json');
  const stamp = join(dir, 'node_modules', '.dev-install-stamp');
  if (!existsSync(lock) || !existsSync(stamp)) return true;
  try { return readFileSync(lock, 'utf8') !== readFileSync(stamp, 'utf8'); } catch { return true; }
}

const writeStamp = (dir) => writeFileSync(join(dir, 'node_modules', '.dev-install-stamp'), readFileSync(join(dir, 'package-lock.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
    p.on('exit', (code) => res(code ?? 1));
    p.on('error', () => res(1));
  });
}

async function waitTcp(host, port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    const ok = await new Promise((res) => {
      const c = connect(port, host);
      c.once('connect', () => { c.destroy(); res(true); });
      c.once('error', () => res(false));
      c.setTimeout(2000, () => { c.destroy(); res(false); });
    });
    if (ok) { log(`${label} is ready`); return; }
    if (Date.now() > deadline) throw new Error(`${label} never came up (${host}:${port})`);
    if (i % 20 === 0) log(`waiting for ${label} (${host}:${port})...`);
    await sleep(500);
  }
}

async function waitHttpOk(url, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; ; i++) {
    try { if ((await fetch(url)).ok) { log(`${label} is ready`); return; } } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`${label} never answered OK (${url})`);
    if (i % 15 === 0) log(`waiting for ${label}...`);
    await sleep(2000);
  }
}

async function ensureInstalls() {
  // API first: the plugin step links the host-provided packages INTO apps/api/node_modules.
  if (installStampStale(API)) {
    log('installing the API dependencies (npm ci, cached between runs)');
    if ((await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: API })) !== 0) throw new Error('api npm ci failed');
    writeStamp(API);
  }
  // The root package.json is GENERATED from the plugin manifests: refresh it, install, then verify.
  if ((await run('node', ['scripts/plugin-deps.mjs'], { cwd: REPO })) !== 0) throw new Error('plugin-deps failed');
  if (installStampStale(REPO)) {
    log('installing the shared plugin dependencies (npm ci at the repository root)');
    if ((await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: REPO })) !== 0) throw new Error('root npm ci failed');
    writeStamp(REPO);
  }
  if ((await run('node', ['scripts/plugin-deps.mjs', '--check'], { cwd: REPO })) !== 0) throw new Error('plugin-deps check failed');
  // Dev signing keys + trust store, plugins re-signed from the current sources (idempotent).
  if ((await run('node', ['scripts/plugin-dev-setup.mjs'], { cwd: REPO })) !== 0) throw new Error('plugin dev signing failed');
}

const buildOnce = async () => (await run('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: API })) === 0;

/** Resolves 'change' when a watched file is newer than `since`, or 'exit' when the child stops. */
function waitForChangeOrExit(roots, since, child) {
  return new Promise((res) => {
    let done = false;
    const finish = (why) => { if (!done) { done = true; clearInterval(timer); res(why); } };
    if (child) child.once('exit', () => finish('exit'));
    const timer = setInterval(() => {
      // A file saved in the same millisecond window as the snapshot must still count as a change.
      if (latestMtimeMs(roots) > since + 1) {
        clearInterval(timer);
        setTimeout(() => finish('change'), 700); // debounce: let the save burst settle
      }
    }, 1000);
  });
}

let current = null;
const stopCurrent = () => { try { current?.kill('SIGTERM'); } catch { /* gone */ } };

async function main() {
  process.once('SIGTERM', () => { stopCurrent(); process.exit(0); });
  process.once('SIGINT', () => { stopCurrent(); process.exit(0); });
  log('waiting for dolt:3306 and nats:4222');
  await waitTcp('dolt', 3306, 120_000, 'Dolt');
  await waitTcp('nats', 4222, 120_000, 'NATS');
  log('waiting for the Rust core (the FIRST container build compiles it: several minutes, then cached)');
  await waitHttpOk(process.env.CORE_HEALTH_URL ?? 'http://127.0.0.1:8081/health', 20 * 60_000, 'core');
  await ensureInstalls();
  let since = latestMtimeMs(WATCHED);
  for (;;) {
    if (!(await buildOnce())) {
      log('TypeScript build failed; the previous server keeps its state, retrying on the next save');
      await waitForChangeOrExit(WATCHED, since, null);
      since = latestMtimeMs(WATCHED);
      continue;
    }
    log('starting the API on :3000');
    const child = spawn('node', ['dist/main.js'], { cwd: API, stdio: 'inherit', env: process.env });
    current = child;
    const why = await waitForChangeOrExit(WATCHED, since, child);
    current = null;
    since = latestMtimeMs(WATCHED);
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { child.once('exit', r); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } r(); }, 5000); });
    if (why === 'exit') { log('the API stopped on its own (see its output above); rebuilding and restarting'); await sleep(1000); }
    else log('source change detected; recompiling and restarting the API');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[api-dev] FATAL: ${e.message}`); process.exit(1); });
}
