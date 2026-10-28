import { newPkce } from './pkce';

export const REDIRECT = 'http://localhost:4200/callback'; // registered redirect_uri of the demo client (not used for navigation: JSON flow)

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
