/**
 * Plugin host over the core's event bus (step 2). Enabled when IAM_BUS_NATS_URL + IAM_BUS_NATS_PASSWORD and
 * IAM_CORE_ADMIN_TOKEN are set; otherwise the API serves plugins in process (step 1 behaviour, unchanged).
 *
 * - At startup the host declares the platform kinds (pure-async hooks as notify kinds) to the core, pushes each
 *   active plugin's deliveries and emission grants (POST /v1/bus/plugins/register: idempotent, replaces the set),
 *   then serves `plugin.<id>.call` over NATS as the restricted `api-host` user.
 * - Enable/disable changes trigger a re-push (registry activity listener); a 60 s timer re-pushes everything:
 *   the core holds registrations in memory only, so a core restart is healed automatically.
 * - Each delivery checks the plugin is still active for the tenant and dedupes on the effect key (ledger in
 *   memory; a durable ledger belongs to the later effects step). A redelivered effect gets a `deduped` reply
 *   instead of a second run.
 */
import { connect, Msg, NatsConnection, Subscription, JSONCodec } from 'nats';
import { HOOKS, PluginContext } from './hooks.js';
import { BusBridge, PluginRegistry } from './registry.js';
import { validateSettings } from './settings.js';

const jc = JSONCodec<unknown>();
const DEFAULT_TENANT = 'acme-demo';
const LEDGER_MAX = 10_000;

interface BusEnvelope { id: string; kind: string; tenant?: string; effect_key?: string; payload: unknown; source?: string }

export class BusHost {
  private routedKinds = new Set<string>();
  private serving = new Map<string, Subscription>();
  private ledger = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  /** Resolves the CURRENT registry at every use: in workspace mode the main registry is rebuilt on each applied
   * version, and this host must never be recreated (one NATS client, one set of subscriptions, no double serving). */
  private constructor(
    private nc: NatsConnection,
    private coreUrl: string,
    private token: string,
    private registry: () => Promise<PluginRegistry>,
    private log: (e: Record<string, unknown>) => void,
  ) {}

  /** Connects and starts the host, or returns undefined when the bus is not configured. Startup failure throws:
   * the process then keeps the in-process path (the bus bridge is never attached, so no kind is routed). */
  static async startIfConfigured(registry: () => Promise<PluginRegistry>, log: (e: Record<string, unknown>) => void = (e) => console.log(`[bus-host] ${JSON.stringify(e)}`)): Promise<BusHost | undefined> {
    const url = process.env.IAM_BUS_NATS_URL;
    const pass = process.env.IAM_BUS_NATS_PASSWORD;
    const token = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url && !pass) return undefined;
    if (!url || !pass || !token) { log({ warn: 'bus host disabled: IAM_BUS_NATS_URL, IAM_BUS_NATS_PASSWORD and IAM_CORE_ADMIN_TOKEN are all required' }); return undefined; }
    const user = process.env.IAM_BUS_NATS_USER ?? 'api-host';
    const coreUrl = (process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
    try {
      const nc = await connect({ servers: url, user, pass, inboxPrefix: '_INBOX.api-host', timeout: 5000 });
      const host = new BusHost(nc, coreUrl, token, registry, log);
      await host.declarePlatformKinds();
      await host.sync();
      host.timer = setInterval(() => { host.sync().catch((e) => log({ warn: 'bus resync failed', error: String(e) })); }, 60_000);
      host.timer.unref?.();
      // Enable/disable re-pushes via the activity listener of the CURRENT registry; after a rebuild the 60 s
      // timer re-attaches it (attachActivity runs on every sync).
      host.attachActivity();
      log({ info: 'plugin host connected to the core bus', url, user });
      return host;
    } catch (e) {
      log({ warn: 'bus host disabled: startup failed, plugins stay in process', error: String(e) });
      return undefined;
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const r = await fetch(`${this.coreUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': this.token }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path} -> ${r.status}: ${j.error ?? r.statusText}`);
    return j;
  }

  /** Platform kinds = hooks whose only mode is async. Blocking hooks stay in process until the auth migration step. */
  private async declarePlatformKinds() {
    const kinds = [...HOOKS.entries()].filter(([, modes]) => modes.length === 1 && modes[0] === 'async').map(([name]) => ({ name, mode: 'notify' as const }));
    await this.post('/v1/bus/plugins/register', { plugin: 'api', subscriptions: [], emits: [], declare_kinds: kinds });
    for (const k of kinds) this.routedKinds.add(k.name);
  }

  private listeningOn?: PluginRegistry;
  private attachActivity() {
    this.registry().then((r) => {
      if (this.listeningOn === r) return;
      this.listeningOn = r;
      r.onActivityChange(() => { this.sync().catch((e) => this.log({ warn: 'bus resync failed', error: String(e) })); });
    }).catch(() => {});
  }

  /** Pushes the registrations of every active plugin and serves their deliveries. Idempotent; replaces the set.
   * A plugin active in ANY tenant with state is registered; each delivery still checks isActive for the envelope's
   * own tenant, so a plugin disabled for a tenant stays silent for that tenant (mono-tenant POC: one real tenant). */
  /** Serialized: every caller waits until all queued syncs have actually run (no lost re-push, no overlap). */
  sync(): Promise<void> {
    const run = this.chain.then(() => this.doSync());
    this.chain = run.catch(() => {});
    return run;
  }

  private async doSync(): Promise<void> {
    {
      const registry = await this.registry();
      this.attachActivity();
      const want = new Map<string, { subscriptions: unknown[]; emits: string[]; declare_kinds: unknown[] }>();
      for (const tenant of new Set([DEFAULT_TENANT, ...registry.tenants()]))
      for (const info of registry.list(tenant)) {
        if (!info.enabled) continue;
        const impl = registry.impl(info.id);
        if (!impl) continue;
        const m = impl.manifest;
        const subscriptions: unknown[] = m.hooks
          .filter((h) => h.mode === 'async' && this.routedKinds.has(h.name))
          .map((h) => ({ kind: h.name }));
        const declare_kinds: unknown[] = [];
        for (const s of m.subscribes ?? []) {
          subscriptions.push(s.mode === 'async' ? { kind: s.name, group: s.group } : { kind: s.name, mandatory: !!s.mandatory });
          declare_kinds.push({ name: s.name, mode: s.mode === 'async' ? 'notify' : 'control' });
        }
        for (const e of m.emits ?? []) declare_kinds.push({ name: e, mode: 'notify' });
        if (!subscriptions.length && !declare_kinds.length && !(m.emits ?? []).length) continue;
        want.set(m.id, { subscriptions, emits: m.emits ?? [], declare_kinds });
      }
      for (const [id, reg] of want) {
        await this.post('/v1/bus/plugins/register', { plugin: id, ...reg });
        this.serve(id);
      }
      for (const [id, sub] of [...this.serving]) {
        if (want.has(id)) continue;
        sub.unsubscribe();
        this.serving.delete(id);
        await this.post('/v1/bus/plugins/unregister', { plugin: id }).catch(() => {});
      }
    }
  }

  private serve(id: string) {
    if (this.serving.has(id)) return;
    const sub = this.nc.subscribe(`plugin.${id}.call`);
    this.serving.set(id, sub);
    (async () => {
      for await (const msg of sub) await this.deliver(id, msg).catch(() => {}); // a failing delivery stays silent (fail closed)
    })().catch(() => {});
  }

  private async deliver(id: string, msg: Msg) {
    const env = jc.decode(msg.data) as BusEnvelope;
    const tenant = env.tenant ?? DEFAULT_TENANT;
    const reply = (data: unknown, verdict?: 'allow' | 'deny') => msg.respond(jc.encode({ from: id, id: env.id, verdict, data }));
    if (env.effect_key) {
      const key = `${tenant}:${id}:${env.kind}:${env.effect_key}`;
      if (this.ledger.has(key)) { reply({ deduped: true }); return; } // redelivery: the effect already ran, say so without running it twice
      this.ledger.add(key);
      if (this.ledger.size > LEDGER_MAX) this.ledger.delete(this.ledger.values().next().value!);
    }
    const registry = await this.registry();
    const impl = registry.impl(id);
    if (!impl || !registry.isActive(tenant, id)) return; // disabled between registration and delivery: stay silent
    const handler = impl.handlers[env.kind];
    if (!handler) return;
    const settings = validateSettings(impl.manifest.settings, (await registry.settingsFor(tenant, id)) ?? {}).values;
    const ctx: PluginContext = { tenant, settings };
    const result = await handler(env.payload, ctx);
    const verdict = result?.outcome === 'allow' ? 'allow' as const : result?.outcome === 'deny' ? 'deny' as const : undefined;
    reply(result ?? null, verdict);
  }

  /** Stops the host (tests and shutdown): no more deliveries, no more re-pushes. */
  async close() { if (this.timer) clearInterval(this.timer); for (const s of this.serving.values()) s.unsubscribe(); await this.nc.close(); }

  /** The registry's bridge: routes only the platform async kinds this host declared. */
  bridge(): BusBridge {
    return {
      routed: (kind) => this.routedKinds.has(kind),
      emit: async (tenant, kind, payload, effectKey) => {
        const r = await this.post('/v1/bus/emit', { source: 'api', kind, tenant, payload, effect_key: effectKey });
        return (r.outcomes ?? []).filter((o: any) => o.status === 'replied').map((o: any) => ({ plugin: o.id, result: o.data }));
      },
      call: async (tenant, kind, payload, timeoutMs) => {
        const r = await this.post('/v1/bus/emit', { source: 'api', kind, tenant, payload, timeout_ms: timeoutMs });
        const replied = (r.outcomes ?? []).filter((o: any) => o.status === 'replied');
        return { verdict: r.verdict, reason: r.reason, result: replied[replied.length - 1]?.data };
      },
    };
  }
}
