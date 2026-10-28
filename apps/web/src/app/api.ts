import { newPkce } from './pkce';

export const REDIRECT = 'http://localhost:4200/callback'; // registered redirect_uri: the console itself, served at http://localhost:4200
/** Where the BROWSER reaches the core for the form (loopback). Not proxied: the form posts to the core origin. */
export const CORE_PUBLIC = 'http://127.0.0.1:8081';

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

  private async call<T>(method: string, path: string, body?: object): Promise<{ status: number; data: T }> {
    const r = await this.f(`/api/tenants/${this.tenant}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` }, body: body ? JSON.stringify(body) : undefined,
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
