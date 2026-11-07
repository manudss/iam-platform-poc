/**
 * Step 3 cleanup (decision 6): the event bus is MANDATORY on the API - a Nest module that includes
 * PluginsV1Module cannot boot without a reachable nats-server AND core. Unit specs that boot such a module
 * use this helper: one nats-server + one iam-core per spec FILE (node --test runs files in parallel processes,
 * so ports derive from the caller's file name). Fails loudly when a required binary is missing.
 *
 *   let bus: TestBus;
 *   before(async () => { bus = await startTestBus(import.meta.url); });
 *   after(async () => { await bus?.close(); });
 *
 * The helper sets IAM_BUS_NATS_URL/USER/PASSWORD, IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN; close() restores them.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'nats';

const root = resolve(process.cwd(), '../..');
export const testBusCoreBin = resolve(root, 'core/target/debug/iam-core');
export const testBusNatsBin = process.env.NATS_SERVER_BIN;
export const testBusBinsPresent = !!testBusNatsBin && existsSync(testBusNatsBin!) && existsSync(testBusCoreBin);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Each compiled spec has a unique slot in the sorted spec inventory, independent of checkout directory. */
function ports(seed: string): { nats: number; core: number } {
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const files = readdirSync(dist, { recursive: true }).map(String).filter(f => f.endsWith('.spec.js')).sort();
  const slot = files.indexOf(relative(dist, fileURLToPath(seed)));
  if (slot < 0) throw new Error('test bus caller is not in the compiled spec inventory');
  return { nats: 16000 + slot, core: 19000 + slot };
}

export interface TestBus { natsPort: number; coreUrl: string; token: string; close(): Promise<void> }

/** A spec process killed before close() (timeout, OOM, hard exit) orphans its nats+core: they keep the
 * ports and serve their stale JetStream state to every later run of the same spec (mysterious red specs).
 * The pid file lets the next run reclaim its slot. */
function killLeftovers(dir: string) {
  try {
    const pids: number[] = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  } catch { /* no pid file: nothing to reclaim */ }
}

export async function startTestBus(seedUrl: string): Promise<TestBus> {
  if (!testBusBinsPresent) throw new Error('test bus: NATS_SERVER_BIN or the core binary is missing');
  const { nats: natsPort, core: corePort } = ports(seedUrl);
  const token = `test-bus-token-${natsPort}`;
  const dir = join(tmpdir(), `iam-test-bus-${natsPort}`);
  killLeftovers(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const conf = readFileSync(resolve(root, 'conf/nats-local.conf'), 'utf8')
    .replace('127.0.0.1:4222', `127.0.0.1:${natsPort}`)
    .replace('/tmp/iam-nats-js', join(dir, 'js'));
  writeFileSync(join(dir, 'nats.conf'), conf);
  const nats = spawn(testBusNatsBin!, ['-c', join(dir, 'nats.conf')], { stdio: 'ignore' });
  nats.unref();
  for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${natsPort}`, timeout: 500 })).close(); break; } catch { await sleep(100); } }
  if (nats.exitCode !== null) throw new Error(`test bus: nats-server exited at startup (port ${natsPort} still held by a leftover process?)`);
  const coreUrl = `http://127.0.0.1:${corePort}`;
  const core = spawn(testBusCoreBin, [], {
    stdio: 'ignore',
    env: { ...process.env, IAM_CORE_NATS_URL: `127.0.0.1:${natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev',
      IAM_CORE_ADMIN_TOKEN: token, IAM_CORE_ADDR: `127.0.0.1:${corePort}`, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') },
  });
  core.unref();
  writeFileSync(join(dir, 'pids.json'), JSON.stringify([nats.pid, core.pid]));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${coreUrl}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { await sleep(100); } }
  if (core.exitCode !== null) throw new Error(`test bus: iam-core exited at startup (port ${corePort} still held by a leftover process?)`);
  const saved: Record<string, string | undefined> = {};
  for (const k of ['IAM_BUS_NATS_URL', 'IAM_BUS_NATS_USER', 'IAM_BUS_NATS_PASSWORD', 'IAM_CORE_URL', 'IAM_CORE_ADMIN_TOKEN']) saved[k] = process.env[k];
  Object.assign(process.env, {
    IAM_BUS_NATS_URL: `127.0.0.1:${natsPort}`, IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev',
    IAM_CORE_URL: coreUrl, IAM_CORE_ADMIN_TOKEN: token,
  });
  return {
    natsPort, coreUrl, token,
    async close() {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      const stops: Promise<unknown>[] = [];
      for (const c of [core, nats]) { if (c.exitCode === null && c.signalCode === null) { const exit = once(c, 'exit'); c.kill('SIGKILL'); stops.push(exit); } }
      await Promise.all(stops);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
