/**
 * In-process fake of the registry's BusBridge, for UNIT specs (no NATS, no core). The registry itself is bus-only
 * since the step 3 cleanup (decision 6): without a bridge every hook call refuses. This fake mirrors the BUS
 * contract, not the old in-process paths:
 * - call: only the plugin CHOSEN for the slot answers (blockingResponder); a deny or an error = verdict deny;
 *   nobody concerned = answered false (which callSlot/control refuse, exactly like a silent bus);
 * - query: merged fields of the concerned responders, conflicts listed, first answer kept;
 * - emit: fan-out to the active plugins declaring the async hook (the dedupe by effectKey stays registry-side).
 * Use `reg.setBus(fakeBusBridge(reg))` after registering the plugins; re-attach after registering more.
 */
import type { BusBridge, PluginRegistry } from '../plugins/v1/registry.js';
import { validateSettings } from '../plugins/v1/settings.js';

export function fakeBusBridge(registry: PluginRegistry, routed: (kind: string) => boolean = () => true): BusBridge {
  const run = async (tenant: string, id: string, kind: string, payload: unknown) => {
    const impl = registry.impl(id)!;
    const settings = validateSettings(impl.manifest.settings, (await registry.settingsFor(tenant, id)) ?? {}).values;
    return impl.handlers[kind](payload, { tenant, settings });
  };
  const responders = (tenant: string, kind: string) =>
    registry.list(tenant).filter((i) => i.enabled && registry.impl(i.id)?.handlers[kind] && registry.blockingResponder(tenant, i.id, kind) === 'answer').map((i) => i.id);
  return {
    routed,
    async call(tenant, kind, payload, timeoutMs = 2000) {
      const refusers = registry.list(tenant).filter((i) => i.enabled && registry.impl(i.id)?.handlers[kind] && registry.blockingResponder(tenant, i.id, kind) === 'refuse').map((i) => i.id);
      if (refusers.length) return { verdict: 'deny', reason: `${refusers[0]} is faulted: refused until an admin disables or re-enables it`, result: undefined, answered: true, answeredBy: refusers[0] };
      const ids = responders(tenant, kind);
      if (!ids.length) return { verdict: 'deny', reason: 'no responder', result: undefined, answered: false };
      try {
        const result = await Promise.race([
          run(tenant, ids[0], kind, payload) as Promise<{ outcome?: string; reason?: string } | undefined>,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`handler timeout after ${timeoutMs}ms`)), timeoutMs)),
        ]);
        if (result?.outcome === 'deny') return { verdict: 'deny', reason: result.reason ?? 'denied', result, answered: true, answeredBy: ids[0], businessDenial: true };
        return { verdict: 'allow', result, answered: true, answeredBy: ids[0] };
      } catch (e) {
        // Like the bus-host delivery: the fault is recorded (persisted, audited, later calls refuse) and the answer is a deny.
        await registry.markFaulted(tenant, ids[0], String((e as Error).message ?? e));
        return { verdict: 'deny', reason: String((e as Error).message ?? e), result: undefined, answered: true };
      }
    },
    async query(tenant, kind, payload) {
      const data: Record<string, unknown> = {}; const conflicts: string[] = []; const answeredBy: string[] = [];
      for (const id of responders(tenant, kind)) {
        try {
          const res = (await run(tenant, id, kind, payload)) as Record<string, unknown> | undefined;
          for (const [k, v] of Object.entries(res ?? {})) {
            if (k in data && data[k] !== v) { if (!conflicts.includes(k)) conflicts.push(k); } else data[k] = v;
          }
          answeredBy.push(id);
        } catch { /* an erroring query responder simply does not appear, like on the bus */ }
      }
      return { data, conflicts, answeredBy };
    },
    async emit(tenant, kind, payload) {
      const out: { plugin: string; result: unknown }[] = [];
      for (const i of registry.list(tenant)) {
        const impl = registry.impl(i.id);
        if (!i.enabled || !impl?.manifest.hooks.some((h) => h.name === kind && h.mode === 'async') || !impl.handlers[kind]) continue;
        out.push({ plugin: i.id, result: await run(tenant, i.id, kind, payload) });
      }
      return out;
    },
  };
}
