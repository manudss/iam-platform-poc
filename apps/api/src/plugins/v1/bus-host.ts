/**
 * Plugin host over the core's event bus (step 3, bus host v2). Enabled when IAM_BUS_NATS_URL + IAM_BUS_NATS_PASSWORD
 * and IAM_CORE_ADMIN_TOKEN are set; otherwise the API serves plugins in process (step 1 behaviour, unchanged).
 *
 * v2 changes:
 * - Deliveries are resolved against the registry of the envelope's BRANCH (decision 7: branch events travel on
 *   the same bus, the handlers always run): a plugin disabled on that branch consumes the delivery without effect.
 * - The effect ledger is the JetStream KV bucket `iam-effects` (decision 3): it survives API restarts, so a
 *   redelivery after a restart is still deduplicated. The bucket is created by the core; the host only binds it.
 * - Services inside the API process (workflow triggers, audit trail, activation effects) can consume their own
 *   durable delivery address via serveService, without a plugin manifest.
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
import { createHash } from 'node:crypto';
import { connect, AckPolicy, ConsumerMessages, JsMsg, JSONCodec, KV, Msg, NatsConnection, Subscription, JetStreamClient, nanos } from 'nats';
import { AppEvent, AppEvents, APP_EVENT_KINDS } from '../../events/app-events.service.js';
import { HOOKS, PluginContext } from './hooks.js';
import { BusBridge, PluginRegistry } from './registry.js';
import { validateSettings } from './settings.js';

const jc = JSONCodec<unknown>();
const DEFAULT_TENANT = 'acme-demo';

interface BusEnvelope { id: string; kind: string; tenant?: string; branch?: string; effect_key?: string; payload: unknown; source?: string }

const EVENTS_STREAM = 'IAM_BUS_EVENTS'; // owned by the core (step 3)
const EFFECTS_BUCKET = 'iam-effects'; // KV effect ledger, created by the core (decision 3)

/** Blocking kinds that travel on the bus as mandatory controls (step 3, auth migration): the serving plugin
 * answers `plugin.<id>.call`, the core merges the verdict, a silent mandatory subscriber denies (fail closed)
 * and the caller refuses when nobody answered at all. ui.screens and access.decide stay in process (decision 8). */
export const BUS_CONTROL_KINDS = new Set(['auth.authenticate', 'auth.challenge', 'risk.score']);
/** Blocking kinds that travel on the bus as merged QUERIES (step 3): every active plugin answers with the
 * fields it owns, the core merges the objects; a silent or disabled plugin simply does not appear. */
export const BUS_QUERY_KINDS = new Set(['profile.enrich']);

/** KV keys accept [A-Za-z0-9_./=-]: the composite key uses '/' and every part is sanitized. */
function ledgerKey(tenant: string, id: string, kind: string, effectKey: string): string {
  const clean = (x: string) => x.replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 80);
  return `${clean(tenant)}/${clean(id)}/${clean(kind)}/${clean(effectKey)}`;
}

export class BusHost {
  private routedKinds = new Set<string>();
  private serving = new Map<string, Subscription>();
  private events = new Map<string, Promise<void>>(); // delivery address -> running durable-consumer loop
  private eventMsgs = new Map<string, ConsumerMessages>(); // delivery address -> live pull, stopped on close
  private services = new Map<string, { kinds: string[]; handler: (env: BusEnvelope) => Promise<void> }>();
  private chain: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  /** Resolves the CURRENT registry at every use: in workspace mode the main registry is rebuilt on each applied
   * version, and this host must never be recreated (one NATS client, one set of subscriptions, no double serving).
   * `registryFor` resolves a working branch (decision 7); absent, every delivery uses the main registry.
   * `allRegistries` lists every loaded branch registry so the pushed registrations cover all of them. */
  private constructor(
    private nc: NatsConnection,
    private js: JetStreamClient,
    private kv: KV,
    private coreUrl: string,
    private token: string,
    private registry: () => Promise<PluginRegistry>,
    private log: (e: Record<string, unknown>) => void,
    private registryFor: (branch: string) => Promise<PluginRegistry> = () => registry(),
    private allRegistries: () => Promise<[string, PluginRegistry][]> = async () => [['main', await registry()]],
  ) {}

  /** Connects and starts the host, or returns undefined when the bus is not configured. Startup failure throws:
   * the process then keeps the in-process path (the bus bridge is never attached, so no kind is routed). */
  static async startIfConfigured(
    registry: () => Promise<PluginRegistry>,
    log: (e: Record<string, unknown>) => void = (e) => console.log(`[bus-host] ${JSON.stringify(e)}`),
    registryFor?: (branch: string) => Promise<PluginRegistry>,
    allRegistries?: () => Promise<[string, PluginRegistry][]>,
  ): Promise<BusHost | undefined> {
    const url = process.env.IAM_BUS_NATS_URL;
    const pass = process.env.IAM_BUS_NATS_PASSWORD;
    const token = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url && !pass) return undefined;
    if (!url || !pass || !token) { log({ warn: 'bus host disabled: IAM_BUS_NATS_URL, IAM_BUS_NATS_PASSWORD and IAM_CORE_ADMIN_TOKEN are all required' }); return undefined; }
    const user = process.env.IAM_BUS_NATS_USER ?? 'api-host';
    const coreUrl = (process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
    try {
      const nc = await connect({ servers: url, user, pass, inboxPrefix: '_INBOX.api-host', timeout: 5000 });
      const js = nc.jetstream();
      const kv = await js.views.kv(EFFECTS_BUCKET, { bindOnly: true }); // created by the core; bindOnly: api-host cannot create streams
      const host = new BusHost(nc, js, kv, coreUrl, token, registry, log, registryFor, allRegistries);
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

  /** Platform kinds = hooks whose only mode is async (notify), plus the blocking auth hooks (control, step 3).
   * Re-pushed by every sync: the core holds the catalogue in memory, so a core restart loses the declarations
   * and the plugin subscriptions would fail validation without this heal. */
  private async declarePlatformKinds() {
    const kinds = [...HOOKS.entries()].filter(([, modes]) => modes.length === 1 && modes[0] === 'async').map(([name]) => ({ name, mode: 'notify' as const }));
    // The platform's application events (user.created, sso.login.*, ...) are notify kinds declared by `api` too.
    const appKinds = APP_EVENT_KINDS.map((name) => ({ name, mode: 'notify' as const }));
    const controlKinds = [...BUS_CONTROL_KINDS].map((name) => ({ name, mode: 'control' as const }));
    const queryKinds = [...BUS_QUERY_KINDS].map((name) => ({ name, mode: 'query' as const }));
    await this.post('/v1/bus/plugins/register', { plugin: 'api', subscriptions: [], emits: [...APP_EVENT_KINDS], declare_kinds: [...kinds, ...appKinds, ...controlKinds, ...queryKinds] });
    for (const k of kinds) this.routedKinds.add(k.name);
    for (const k of BUS_CONTROL_KINDS) this.routedKinds.add(k);
    for (const k of BUS_QUERY_KINDS) this.routedKinds.add(k);
  }

  /** Step 3: the application events travel on the bus. Emissions stay fire-and-forget (the producing write is
   * already committed; a bus failure is logged, never propagated) and carry a deterministic effect key: a bus
   * redelivery replays the SAME event (same key, the consumers' handlers absorb the duplicate), while two
   * genuinely distinct events always differ in at least one field. Consumers get their own durable address. */
  attachEvents(events: AppEvents) {
    events.attachBus(
      (e: AppEvent) => {
        const effectKey = createHash('sha256').update(JSON.stringify([e.type, e.tenant, e.branch, e.at, Object.keys(e.payload).sort().map((k) => [k, e.payload[k]])])).digest('hex').slice(0, 48);
        this.post('/v1/bus/emit', { source: 'api', kind: e.type, tenant: e.tenant, branch: e.branch, payload: { ...e.payload, at: e.at }, effect_key: effectKey })
          .catch((err) => this.log({ warn: 'application event not emitted', kind: e.type, error: String(err) }));
      },
      (address, kinds, handler) => { this.serveService(address, kinds, handler).catch((err) => this.log({ warn: 'service not served', address, error: String(err) })); },
    );
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
      await this.declarePlatformKinds();
      this.attachActivity();
      // Union over every loaded branch registry (decision 7: all branches share this bus): a plugin active on
      // ANY branch/tenant gets its delivery address; each delivery is then resolved against its own branch.
      const want = new Map<string, { subscriptions: Map<string, unknown>; emits: Set<string>; declare_kinds: Map<string, unknown> }>();
      const entry = (id: string) => {
        let e = want.get(id);
        if (!e) { e = { subscriptions: new Map(), emits: new Set(), declare_kinds: new Map() }; want.set(id, e); }
        return e;
      };
      for (const [, registry] of await this.allRegistries())
      for (const tenant of new Set([DEFAULT_TENANT, ...registry.tenants()]))
      for (const info of registry.list(tenant)) {
        if (!info.enabled) continue;
        const impl = registry.impl(info.id);
        if (!impl) continue;
        const m = impl.manifest;
        const e = entry(m.id);
        for (const h of m.hooks) {
          if (h.mode === 'async' && this.routedKinds.has(h.name)) e.subscriptions.set(h.name, { kind: h.name });
          // Blocking auth hooks: a MANDATORY control subscription, so the core denies the call when the serving
          // plugin is unreachable (fail closed). The delivery answers not-concerned unless this plugin is the
          // one chosen for the slot (single responder).
          if (h.mode === 'blocking' && BUS_CONTROL_KINDS.has(h.name)) e.subscriptions.set(h.name, { kind: h.name, mandatory: true });
          // Merged queries: an OPTIONAL subscription - a disabled or unreachable plugin simply does not appear.
          if (h.mode === 'blocking' && BUS_QUERY_KINDS.has(h.name)) e.subscriptions.set(h.name, { kind: h.name });
        }
        for (const s of m.subscribes ?? []) {
          e.subscriptions.set(s.name + (s.group ? `/${s.group}` : ''), s.mode === 'async' ? { kind: s.name, group: s.group } : { kind: s.name, mandatory: !!s.mandatory });
          e.declare_kinds.set(s.name, { name: s.name, mode: s.mode === 'async' ? 'notify' : 'control' });
        }
        for (const k of m.emits ?? []) { e.emits.add(k); e.declare_kinds.set(k, { name: k, mode: 'notify' }); }
        if (!e.subscriptions.size && !e.declare_kinds.size && !e.emits.size) want.delete(m.id);
      }
      for (const [id, reg] of want) {
        await this.post('/v1/bus/plugins/register', { plugin: id, subscriptions: [...reg.subscriptions.values()], emits: [...reg.emits], declare_kinds: [...reg.declare_kinds.values()] });
        this.serve(id);
      }
      // Internal services keep their own durable addresses; re-pushed here so a core restart heals them too.
      for (const [address, svc] of this.services) {
        await this.post('/v1/bus/plugins/register', { plugin: address, subscriptions: svc.kinds.map((kind) => ({ kind })), emits: [], declare_kinds: [] });
        this.serveEvents(address, (env) => svc.handler(env));
      }
      for (const [id, sub] of [...this.serving]) {
        if (want.has(id)) continue;
        sub.unsubscribe();
        this.serving.delete(id);
        this.events.delete(id); // the loop stops at the next message; the durable consumer stays (deliveries wait)
        await this.post('/v1/bus/plugins/unregister', { plugin: id }).catch(() => {});
      }
    }
  }

  /** A service of the API process (not a plugin) consumes its own durable delivery address. The core must
   * already know the kinds (platform kinds are declared at startup); registrations are re-pushed by every sync. */
  async serveService(address: string, kinds: string[], handler: (env: BusEnvelope) => Promise<void>): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(address)) throw new Error(`invalid service address '${address}'`);
    this.services.set(address, { kinds, handler });
    await this.post('/v1/bus/plugins/register', { plugin: address, subscriptions: kinds.map((kind) => ({ kind })), emits: [], declare_kinds: [] });
    this.serveEvents(address, handler);
  }

  private serve(id: string) {
    if (this.serving.has(id)) return;
    const sub = this.nc.subscribe(`plugin.${id}.call`);
    this.serving.set(id, sub);
    (async () => {
      for await (const msg of sub) await this.deliver(id, msg).catch(() => {}); // a failing delivery stays silent (fail closed)
    })().catch(() => {});
    this.serveEvents(id);
  }

  /** Step 3: durable event deliveries. One durable pull consumer per plugin on the core's IAM_BUS_EVENTS
   * stream (filter `bus.events.<id>`); the message is acked only AFTER the handler ran (at-least-once: a crash
   * or a nak means redelivery, the effect ledger dedupes). A plugin that is disabled or has no handler acks
   * without acting: the delivery is consumed, there is simply no effect (never a redelivery loop). */
  private serveEvents(id: string, service?: (env: BusEnvelope) => Promise<void>) {
    if (this.events.has(id)) return;
    this.events.set(id, (async () => {
      const jsm = await this.js.jetstreamManager(false); // false: no $JS.API.INFO ping (api-host has consumer rights only)
      try { await jsm.consumers.info(EVENTS_STREAM, id); }
      catch {
        await jsm.consumers.add(EVENTS_STREAM, {
          durable_name: id, filter_subject: `bus.events.${id}`,
          ack_policy: AckPolicy.Explicit, max_deliver: 10, ack_wait: nanos(30_000),
        });
      }
      const consumer = await this.js.consumers.get(EVENTS_STREAM, id);
      const messages = await consumer.consume();
      this.eventMsgs.set(id, messages);
      for await (const m of messages) {
        if (!this.events.has(id)) { messages.stop(); break; }
        await this.deliverEvent(id, m, service).catch((e) => { this.log({ warn: 'event delivery failed, redelivery scheduled', plugin: id, error: String(e) }); m.nak(5_000); }); // nats.js nak() takes milliseconds
      }
    })().catch((e) => { this.events.delete(id); this.log({ warn: 'event consumer stopped', plugin: id, error: String(e) }); }));
  }

  private async deliverEvent(id: string, m: JsMsg, service?: (env: BusEnvelope) => Promise<void>): Promise<void> {
    const env = jc.decode(m.data) as BusEnvelope;
    const tenant = env.tenant ?? DEFAULT_TENANT;
    let run: () => Promise<void>;
    if (service) {
      run = () => service(env);
    } else {
      // Decision 7: the effect runs against the registry of the envelope's branch (never silently main's).
      let registry: PluginRegistry;
      try { registry = await this.registryFor(env.branch ?? 'main'); }
      catch (e) { this.log({ warn: 'unknown branch, delivery consumed without effect', plugin: id, branch: env.branch, error: String(e) }); m.ack(); return; }
      const impl = registry.impl(id);
      const handler = impl && registry.isActive(tenant, id) ? impl.handlers[env.kind] : undefined;
      if (!handler) { m.ack(); return; } // not concerned on this branch (disabled or unknown): consumed, no effect
      run = async () => {
        const settings = validateSettings(impl!.manifest.settings, (await registry.settingsFor(tenant, id)) ?? {}).values;
        await handler(env.payload, { tenant, settings } as PluginContext);
      };
    }
    // Effect first, ledger second, ack last (decision 4): a crash before the ack redelivers and the effect may
    // run twice, which effect keys and idempotent handlers absorb; the reverse order could lose the effect.
    await run();
    if (env.effect_key) {
      const key = ledgerKey(tenant, id, env.kind, env.effect_key);
      try { await this.kv.create(key, JSON.stringify({ at: new Date().toISOString(), kind: env.kind })); }
      catch { /* already recorded by a parallel or earlier delivery: keep the ack below, the effect is deduped by handlers */ }
    }
    m.ack();
  }

  private async deliver(id: string, msg: Msg) {
    const env = jc.decode(msg.data) as BusEnvelope;
    const tenant = env.tenant ?? DEFAULT_TENANT;
    const reply = (data: unknown, verdict?: 'allow' | 'deny') => msg.respond(jc.encode({ from: id, id: env.id, verdict, data }));
    if (env.effect_key) {
      const key = ledgerKey(tenant, id, env.kind, env.effect_key);
      try {
        await this.kv.create(key, JSON.stringify({ at: new Date().toISOString(), kind: env.kind, pending: true }));
      } catch { reply({ deduped: true }); return; } // redelivery: the effect already ran, say so without running it twice
    }
    const registry = await this.registryFor(env.branch ?? 'main').catch(() => undefined);
    if (!registry) return; // unknown branch: stay silent (a mandatory control then denies, fail closed)
    if (BUS_QUERY_KINDS.has(env.kind)) {
      // Merged query: every concerned plugin answers with its fields, no verdict; the core merges.
      if (registry.blockingResponder(tenant, id, env.kind) !== 'answer') { msg.respond(jc.encode({ from: id, id: env.id, not_concerned: true })); return; }
      const impl = registry.impl(id)!;
      const settings = validateSettings(impl.manifest.settings, (await registry.settingsFor(tenant, id)) ?? {}).values;
      const result = await impl.handlers[env.kind](env.payload, { tenant, settings } as PluginContext);
      msg.respond(jc.encode({ from: id, id: env.id, data: result ?? null }));
      return;
    }
    if (BUS_CONTROL_KINDS.has(env.kind)) {
      // Single responder: only the plugin chosen for the slot answers; the others say not-concerned (neither an
      // answer nor a silence). A faulted replacement refuses: the base is never asked in its place (callSlot rule).
      const role = registry.blockingResponder(tenant, id, env.kind);
      if (role === 'not-concerned') { msg.respond(jc.encode({ from: id, id: env.id, not_concerned: true })); return; }
      if (role === 'refuse') { reply({ outcome: 'deny', reason: 'plugin-faulted' }, 'deny'); return; }
    }
    const impl = registry.impl(id);
    if (!impl || !registry.isActive(tenant, id)) return; // disabled between registration and delivery: stay silent
    const handler = impl.handlers[env.kind];
    if (!handler) return;
    const settings = validateSettings(impl.manifest.settings, (await registry.settingsFor(tenant, id)) ?? {}).values;
    const ctx: PluginContext = { tenant, settings };
    const result = await handler(env.payload, ctx);
    // 'challenge' is a way forward, not a refusal: only an explicit deny carries the deny verdict; the result
    // data (allow with methods, or the challenge to draw) always rides along.
    const verdict = result?.outcome === 'deny' ? 'deny' as const : 'allow' as const;
    reply(result ?? null, verdict);
  }

  /** Stops the host (tests and shutdown): no more deliveries, no more re-pushes. */
  async close() {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.serving.values()) s.unsubscribe();
    for (const m of this.eventMsgs.values()) m.stop();
    this.events.clear();
    this.eventMsgs.clear();
    await this.nc.close();
  }

  /** The registry's bridge: routes only the platform async kinds this host declared. */
  bridge(): BusBridge {
    return {
      routed: (kind) => this.routedKinds.has(kind),
      // Step 3: a notify emission returns durable-queue receipts, not results. The effects themselves happen
      // asynchronously in the consumers (at-least-once, deduped by the effect key); callers must not await them.
      emit: async (tenant, kind, payload, effectKey, branch) => {
        const r = await this.post('/v1/bus/emit', { source: 'api', kind, tenant, payload, effect_key: effectKey, branch });
        return (r.outcomes ?? []).filter((o: any) => o.status === 'queued').map((o: any) => ({ plugin: o.id, result: { queued: true } }));
      },
      call: async (tenant, kind, payload, timeoutMs, branch) => {
        const r = await this.post('/v1/bus/emit', { source: 'api', kind, tenant, payload, timeout_ms: timeoutMs, branch });
        const replied = (r.outcomes ?? []).filter((o: any) => o.status === 'replied');
        return { verdict: r.verdict, reason: r.reason, result: replied[replied.length - 1]?.data, answered: replied.length > 0 };
      },
      query: async (tenant, kind, payload, timeoutMs, branch) => {
        const r = await this.post('/v1/bus/emit', { source: 'api', kind, tenant, payload, timeout_ms: timeoutMs, branch });
        const replied = (r.outcomes ?? []).filter((o: any) => o.status === 'replied');
        return { data: r.data ?? {}, conflicts: r.conflicts ?? [], answeredBy: replied.map((o: any) => o.id as string) };
      },
    };
  }
}

/** Holds the one bus host of the process so services outside the plugins module (activation, effects) can reach
 * it without a circular module dependency. Set by whoever created the host (plugins-v1 factory or BranchRegistries). */
export class BusHostRef {
  host?: BusHost;
}
