import { HttpException } from '@nestjs/common';
import { PluginError, PluginImpl, PluginRegistry } from './registry.js';
import { loadPluginModule } from './loader.js';

/** The slice of the registry engine resolution needs (a full PluginRegistry satisfies it; specs may stub it). */
export type EngineRegistry = Pick<PluginRegistry, 'resolve'>;

/**
 * Engine slots (step 3): business plugins whose surface is an engine (SSO protocol middleware, workflow
 * runner, MCP gateway, connector registries) cannot ride the bus — payloads there must be JSON and these
 * engines stream, redirect and hold connections. What the registry owns instead is WHICH plugin serves the
 * slot: resolveEngine picks the slot's provider for the tenant (the enabled replacement, or the refusing
 * base), loads that provider's module from its signed folder and hands the caller a cached engine instance.
 *
 * Fail closed: when no provider plugin is enabled the slot resolves to its refusing base and resolveEngine
 * throws PluginError `no-provider` — the adapter maps it to 404, so a disabled plugin's surface is DOWN,
 * not silently served by a default. A replacement plugin (extends the base) takes over with no core change.
 */

/** Created engines, per calling adapter instance (scope) then slot + serving plugin id + entry. Entries are
 * never evicted: a provider switch creates a new key. Scoping per adapter keeps each instance's deps (stores,
 * event buses, test doubles) with its own engines. */
const engines = new WeakMap<object, Map<string, unknown>>();

export async function resolveEngine<E>(
  registry: () => Promise<EngineRegistry>,
  tenant: string, slot: string, entry: string,
  create: (mod: never, impl: PluginImpl) => E,
  scope: object = engines,
): Promise<E> {
  const reg = await registry();
  const impl = reg.resolve(tenant, slot);
  if (impl.manifest.base) throw new PluginError('no-provider', `${slot}: no provider plugin enabled (the slot only has its refusing base)`);
  let byKey = engines.get(scope);
  if (!byKey) { byKey = new Map(); engines.set(scope, byKey); }
  const key = `${slot}:${impl.manifest.id}:${entry}`;
  let e = byKey.get(key) as E | undefined;
  if (!e) { e = create(loadPluginModule(impl.manifest.id, entry) as never, impl); byKey.set(key, e); }
  return e;
}

/** Maps a PluginError to the HTTP shape the other plugin endpoints already use (fail closed: a disabled
 * engine slot answers like an absent route (404), a faulted provider is a 503). */
export function engineHttpError(e: unknown): never {
  if (e instanceof PluginError) throw new HttpException({ code: e.code, message: e.message }, e.code === 'plugin-failed' ? 503 : e.code === 'no-provider' ? 404 : 400);
  throw e;
}
