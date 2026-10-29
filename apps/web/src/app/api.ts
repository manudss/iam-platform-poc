import { newPkce } from './pkce';

/** Origin of THIS console (http://localhost:4200 in `ng serve`, the public URL of the hosted demo). */
const ORIGIN = (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost:4200';
export const REDIRECT = `${ORIGIN}/callback`; // registered redirect_uri: the console itself, on its own origin
/** Where the BROWSER reaches the core for the sign-in form: the same origin under /core (proxied by ng serve
 *  locally and by demo/server.mjs in the hosted demo), so no loopback URL is ever exposed to the browser. */
export const CORE_PUBLIC = `${ORIGIN}/core`;

export interface Violation { identity: string; roleA: string; roleB: string }
export interface Change { branch: string; commit: string; violations: Violation[]; mergeable: boolean }

/**
 * Thin client. /core and /api are proxied by `ng serve` (proxy.conf.json) to the Rust core (8081) and the NestJS API (3000),
 * so no CORS is needed. The token is kept in memory only (never localStorage), lost on reload. POC prototype flow, not standard OIDC.
 */
export class ApiClient {
  private token = '';
  constructor(private readonly tenant = 'acme-demo', private readonly f: typeof fetch = (...a) => fetch(...a)) {}

  get loggedIn() { return !!this.token; }
  logout() { this.token = ''; }

  /** Recommended sign-in: browser code+PKCE flow. Keeps a fresh state + verifier in sessionStorage and leaves for the core's login form. */
  async startBrowserLogin(storage: Pick<Storage, 'setItem'>, go: (url: string) => void) {
    const { verifier, challenge } = await newPkce();
    const state = (await newPkce()).verifier;
    storage.setItem('iam.pkce.verifier', verifier); storage.setItem('iam.pkce.state', state);
    const q = new URLSearchParams({ response_type: 'code', client_id: 'demo-web', redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256' });
    go(`${CORE_PUBLIC}/authorize?${q}`);
  }

  /** Callback: the returned state must equal the stored one (else the code is ignored); the verifier and state are single use. */
  async completeBrowserLogin(search: string, storage: Pick<Storage, 'getItem' | 'removeItem'>) {
    const p = new URLSearchParams(search);
    const state = storage.getItem('iam.pkce.state'), verifier = storage.getItem('iam.pkce.verifier');
    storage.removeItem('iam.pkce.state'); storage.removeItem('iam.pkce.verifier');
    const code = p.get('code');
    if (!state || !verifier || !code || p.get('state') !== state) throw new Error('sign-in refused: state mismatch (code ignored)');
    const t = await this.f('/core/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'demo-web' }) });
    if (!t.ok) throw new Error('token exchange failed');
    this.token = ((await t.json()) as { id_token: string }).id_token;
  }

  /** LEGACY / diagnostic: JSON login (credentials posted by this page). The browser flow above is the recommended path. */
  async login(username: string, password: string) {
    const { verifier, challenge } = await newPkce();
    const post = (path: string, body: object) => this.f(`/core${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = await post('/authorize', { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: challenge, username, password });
    if (!a.ok) throw new Error('login failed');
    const { code } = (await a.json()) as { code: string };
    const t = await post('/token', { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'demo-web' });
    if (!t.ok) throw new Error('token exchange failed');
    this.token = ((await t.json()) as { id_token: string }).id_token;
  }

  /** Same call as the typed helpers below, with extra headers (used by the plugin administration client). */
  raw<T>(method: string, path: string, body?: object, headers: Record<string, string> = {}) { return this.call<T>(method, path, body, headers); }

  private async call<T>(method: string, path: string, body?: object, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
    const r = await this.f(`/api/tenants/${this.tenant}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...extra }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json().catch(() => ({}))) as T;
    if (!r.ok && r.status !== 409) throw new Error((data as { message?: string }).message ?? `HTTP ${r.status}`);
    return { status: r.status, data };
  }

  async assignments() { return (await this.call<{ identity_id: string; role_id: string }[]>('GET', '/assignments')).data; }
  async simulate(identity: string, role: string) { return (await this.call<Change>('POST', '/changes', { identity, role })).data; }
  /** 409 means refused because of a SoD violation (data.violations lists them). */
  merge(branch: string) { return this.call<{ commit?: string; violations?: Violation[] }>('POST', `/changes/${branch}/merge`); }
  async activate(commit?: string) { return (await this.call<{ seq: number; commit: string; event: string }>('POST', '/activations', commit ? { commit } : {})).data; }
  async activations() { return (await this.call<{ seq: number; commit: string }[]>('GET', '/activations')).data; }
}

// ---- Plugin administration (generic, schema-driven; see docs/plugins.md) ----
export interface PluginInfo {
  id: string; name: string; version: string; kinds: string[]; base: boolean; provides: string[]; extends?: string; enabled: boolean; installed: boolean; faulted?: boolean;
  requests: { install: boolean; sensitiveHooks: string[]; uiComponents: boolean };
  grants: { install?: boolean; hooks?: string[]; uiComponents?: boolean };
}
export interface FormField { key: string; type: string; label: string; help?: string; required?: boolean; options?: { value: string; label: string }[]; value: unknown; group?: string; visibleIf?: { key: string; equals: unknown }; min?: number; max?: number }
export interface FormModel { groups: { name: string; fields: FormField[] }[] }
export interface GrantsInput { install?: boolean; hooks?: string[]; uiComponents?: boolean }

/** Admin calls carry the admin capability token typed by the operator. It is kept in memory only, like the user token. */
export class PluginAdminClient {
  adminToken = '';
  constructor(private readonly api: ApiClient) {}
  list() { return this.api.raw<{ plugins: PluginInfo[] }>('GET', '/plugins').then((r) => r.data.plugins); }
  form(id: string) { return this.api.raw<FormModel>('GET', `/plugins/${id}/form`).then((r) => r.data); }
  private admin<T>(method: string, path: string, body?: object) { return this.api.raw<T>(method, path, body ?? {}, { 'x-api-admin-token': this.adminToken }); }
  install(id: string, grants: GrantsInput) { return this.admin('POST', `/plugins/${id}/install`, { grants }); }
  save(id: string, values: Record<string, unknown>) { return this.admin('PUT', `/plugins/${id}/settings`, { values }); }
  enable(id: string, grants: GrantsInput) { return this.admin('POST', `/plugins/${id}/enable`, { grants }); }
  disable(id: string) { return this.admin('POST', `/plugins/${id}/disable`); }
}
/** Which fields to show now: a field with visibleIf only shows when the referenced field has that value. */
export function visibleFields(fields: FormField[], values: Record<string, unknown>) {
  return fields.filter((f) => !f.visibleIf || values[f.visibleIf.key] === f.visibleIf.equals);
}
/** Turn what the operator typed back into typed values; secrets left masked are not sent (the server keeps the stored value). */
export function formValues(model: FormModel, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of model.groups.flatMap((g) => g.fields)) {
    const v = edited[f.key];
    if (f.type === 'secret' && (v === '********' || v === '' || v === undefined)) continue;
    if (v === undefined || v === '') continue;
    out[f.key] = f.type === 'number' ? Number(v) : f.type === 'list' && typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
  }
  return out;
}
