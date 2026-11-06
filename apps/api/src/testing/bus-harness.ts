/**
 * Shared harness for the e2e specs that need the real bus: a REAL nats-server (with the local users/jetstream
 * conf) and the REAL iam-core binary, plus a BusHost wired like the plugins-v1 module wires it in production.
 * Each spec file passes its OWN port pair (spec files run in parallel processes). Skipped loudly when a binary
 * is missing (busBinsPresent). Sets the IAM_BUS_* / IAM_CORE_* env vars; close() restores them.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'nats';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BusHost, BusHostRef } from '../plugins/v1/bus-host.js';
import { MemoryMigrationStore, MemorySettingsStore } from '../plugins/v1/memory-stores.js';

const root = resolve(process.cwd(), '../..');
export const coreBin = resolve(root, 'core/target/debug/iam-core');
export const natsBin = process.env.NATS_SERVER_BIN;
export const busBinsPresent = !!natsBin && existsSync(natsBin) && existsSync(coreBin);

export interface BusHarness {
  host: BusHost;
  ref: BusHostRef;
  registry: PluginRegistry;
  core?: ChildProcess;
  dir: string;
  natsPort: number;
  coreUrl: string;
  token: string;
  stopNats(): Promise<void>;
  startNats(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startBusHarness(opts: { natsPort: number; corePort?: number; token?: string; registry?: PluginRegistry; registryFor?: (branch: string) => Promise<PluginRegistry>; allRegistries?: () => Promise<[string, PluginRegistry][]> }): Promise<BusHarness> {
  const token = opts.token ?? 'bus-harness-token';
  const dir = join(tmpdir(), `iam-bus-harness-${opts.natsPort}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const conf = readFileSync(resolve(root, 'conf/nats-local.conf'), 'utf8')
    .replace('127.0.0.1:4222', `127.0.0.1:${opts.natsPort}`)
    .replace('/tmp/iam-nats-js', join(dir, 'js'));
  const confPath = join(dir, 'nats.conf');
  writeFileSync(confPath, conf);
  const spawnNats = () => { const c = spawn(natsBin!, ['-c', confPath], { stdio: 'ignore' }); c.unref(); return c; }; // unref: a missed kill must never wedge the spec process
  let nats = spawnNats();
  for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${opts.natsPort}`, timeout: 500 })).close(); break; } catch { await sleep(100); } }
  const coreUrl = opts.corePort ? `http://127.0.0.1:${opts.corePort}` : undefined;
  let core: ChildProcess | undefined;
  if (coreUrl) {
    core = spawn(coreBin, [], { stdio: 'ignore', env: { ...process.env,
      IAM_CORE_NATS_URL: `127.0.0.1:${opts.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev',
      IAM_CORE_ADMIN_TOKEN: token, IAM_CORE_ADDR: `127.0.0.1:${opts.corePort}`,
      IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') } });
    core.unref();
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${coreUrl}/health`, { signal: AbortSignal.timeout(500) })).ok) break; } catch { await sleep(100); } }
  }
  Object.assign(process.env, {
    IAM_BUS_NATS_URL: `127.0.0.1:${opts.natsPort}`, IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev',
    ...(coreUrl ? { IAM_CORE_URL: coreUrl, IAM_CORE_ADMIN_TOKEN: token } : {}),
  });
  const registry = opts.registry ?? new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
  const host = await BusHost.startIfConfigured(async () => registry, undefined, opts.registryFor, opts.allRegistries);
  if (!host) throw new Error('bus host did not start');
  const ref = new BusHostRef();
  ref.host = host;
  const waitNats = async () => { for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${opts.natsPort}`, timeout: 500 })).close(); return; } catch { await sleep(100); } } };
  const harness: BusHarness = {
    host, ref, registry, core, dir, natsPort: opts.natsPort, coreUrl: coreUrl ?? '', token,
    async stopNats() { const exit = once(nats, 'exit'); nats.kill('SIGKILL'); await exit; }, // SIGKILL + await: SIGTERM leaves a graceful lame-duck window where calls still succeed
    async startNats() { nats = spawnNats(); await waitNats(); },
    async close() {
      await host.close(); harness.core?.kill(); nats.kill(); rmSync(dir, { recursive: true, force: true }); // harness.core: a spec may have respawned the core
      delete process.env.IAM_BUS_NATS_URL; delete process.env.IAM_BUS_NATS_USER; delete process.env.IAM_BUS_NATS_PASSWORD;
    },
  };
  return harness;
}
