import { newPkce } from './pkce';

/** Origin of THIS console (http://localhost:4200 in `ng serve`, the public URL of the hosted demo). */
const ORIGIN = (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost:4200';
export const REDIRECT = `${ORIGIN}/callback`; // registered redirect_uri: the console itself, on its own origin
/** Where the BROWSER reaches the core for the sign-in form: the same origin under /core (proxied by ng serve
 *  locally and by demo/server.mjs in the hosted demo), so no loopback URL is ever exposed to the browser. */
export const CORE_PUBLIC = `${ORIGIN}/core`;

export interface SigninChain { id: string; name: string; declaredLevel: number; effectiveLevel: number; mfa: boolean; simulated: boolean; recommended: boolean; steps: { name: string; type: string; simulated: boolean }[]; note?: string }
export interface SigninOptions { mode: 'choice' | 'legacy'; chains: SigninChain[]; note?: string }
export interface SsoRequest { app: { id: string; name: string; description: string }; scopes: string[]; user: { sub: string; name: string }; allowed: boolean }
export interface Violation { identity: string; roleA: string; roleB: string }
export interface Change { branch: string; commit: string; violations: Violation[]; mergeable: boolean }

/**
 * Thin client. /core and /api are proxied by `ng serve` (proxy.conf.json) to the Rust core (8081) and the NestJS API (3000),
 * so no CORS is needed. The token is kept in memory only (never localStorage), lost on reload. POC prototype flow, not standard OIDC.
 */
export class ApiClient {
  private token = '';
  branch = '';

  constructor(private readonly tenant = 'acme-demo', private readonly f: typeof fetch = (...a) => fetch(...a), private readonly onUnauthorized: () => void = () => {}) {}

  get loggedIn() { return !!this.token; }
  /** Unverified claim used only to end the UI session early. The server still verifies every request. */
  get expiresAt(): number | null {
    try { const b = this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); const exp = JSON.parse(atob(b)).exp; return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null; } catch { return null; }
  }
  private unauthorized() { this.logout(); this.onUnauthorized(); return new Error('Session expired or invalid. Sign in again. Your action was not retried.'); }
  /** Display name of the signed-in identity: the `sub` claim of the in-memory token (display only, nothing is trusted from it). */
  get identity(): string {
    try { const b = this.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return (JSON.parse(atob(b)) as { sub?: string }).sub ?? ''; } catch { return ''; }
  }
  logout() { this.token = ''; }

  /** Recommended sign-in: browser code+PKCE flow. Keeps a fresh state + verifier in sessionStorage and leaves for the core's login form. */
  async startBrowserLogin(storage: Pick<Storage, 'setItem'>, go: (url: string) => void, chain?: string, branchTest?: { branch: string; ticket: string }) {
    const { verifier, challenge } = await newPkce();
    const state = (await newPkce()).verifier;
    storage.setItem('iam.pkce.verifier', verifier); storage.setItem('iam.pkce.state', state);
    const params: Record<string, string> = { response_type: 'code', client_id: 'demo-web', redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256' };
    if (chain && /^[a-z0-9-]{1,40}$/.test(chain)) params['chain'] = chain;
    if (branchTest && /^[a-z0-9-]{1,32}$/.test(branchTest.branch) && branchTest.branch !== 'main' && branchTest.ticket) { params['branch'] = branchTest.branch; params['ticket'] = branchTest.ticket; }
    const q = new URLSearchParams(params);
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

  /** Public list of the sign-in methods (chains) the live configuration offers. Names and declared levels only.
   *  A branch test passes the branch and its admin-issued ticket (docs/branch-test.md). */
  async signinOptions(branchTest?: { branch: string; ticket: string }): Promise<SigninOptions> {
    const q = branchTest ? `?branch=${encodeURIComponent(branchTest.branch)}&ticket=${encodeURIComponent(branchTest.ticket)}` : '';
    const r = await this.f(`/api/tenants/${encodeURIComponent(this.tenant)}/signin/options${q}`);
    if (!r.ok) { const m = ((await r.json().catch(() => ({}))) as { message?: string }).message; throw new Error(m ?? 'cannot load the sign-in methods'); }
    return (await r.json()) as SigninOptions;
  }

  /** Automated tests only: the console no longer offers this JSON login. The browser flow above is the only sign-in path of the UI. */
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

  async users() { return (await this.raw<{users: UserProfile[]}>('GET','/users')).data.users; }
  async saveUser(id: string | null, values: object, adminToken = '') {
    const r = await this.raw<UserProfile>(id ? 'PUT' : 'POST', '/users' + (id ? '/' + encodeURIComponent(id) : ''), values, adminToken ? {'x-api-admin-token':adminToken} : {});
    if (r.status === 409) throw new Error((r.data as unknown as {message:string}).message || 'User already exists');
    return r.data;
  }

  /** Same call as the typed helpers below, with extra headers (used by the plugin administration client). */
  raw<T>(method: string, path: string, body?: object, headers: Record<string, string> = {}) { return this.call<T>(method, path, body, headers); }

  private async call<T>(method: string, path: string, body?: object, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
    if (this.token && this.expiresAt !== null && this.expiresAt <= Date.now()) throw this.unauthorized();
    const sentToken = this.token, sentBranch=this.branch;
    // '@/sso/{t}/...' addresses an API route outside /tenants (SSO sign-in requests); {t} is this tenant.
    const r = await this.f(path.startsWith('@') ? `/api${path.slice(1).replace('{t}', encodeURIComponent(this.tenant))}` : `/api/tenants/${this.tenant}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...(this.branch ? {'x-iam-branch':this.branch} : {}), ...extra }, body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await r.json().catch(() => ({}))) as T;
    if(this.branch!==sentBranch)throw new Error('Working branch changed. Request result ignored.');
    if (this.token !== sentToken) throw new Error('Session changed. Request result ignored; check the current state.');
    if (r.status === 401 && this.token === sentToken) throw this.unauthorized();
    if (!r.ok && r.status !== 409) throw new Error((data as { message?: string }).message ?? `HTTP ${r.status}`);
    return { status: r.status, data };
  }

  /** SSO: what an application asks for after the user signed in, and the user's answer. The API returns where the browser goes next. */
  async ssoRequest(uid: string) { return (await this.call<SsoRequest>('GET', `@/sso/{t}/interaction/${encodeURIComponent(uid)}`)).data; }
  async ssoAnswer(uid: string, decision: 'allow' | 'deny') { return (await this.call<{ redirectTo: string }>('POST', `@/sso/{t}/interaction/${encodeURIComponent(uid)}/complete`, { decision })).data; }

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

// ---- Database explorer (Dolt branches, history, diffs, data, SQL console, pull requests; see docs/explorer.md) ----
export interface BranchInfo { name: string; commit: string; committer: string; date: string; message: string; protected: boolean; default: boolean; aheadOfDefault: number; behindDefault: number }
export interface CommitInfo { commit: string; author: string; date: string; message: string; parents: string[]; refs: string[]; merge: boolean }
export interface TableSummary { table: string; from: string | null; kind: string; dataChange: boolean; schemaChange: boolean }
export interface DiffSummary { from: string; to: string; three: boolean; tables: TableSummary[]; schema: { table: string; from: string | null; to: string | null }[] }
export interface RowDiff { type: string; from: Record<string, unknown> | null; to: Record<string, unknown> | null }
export interface ColumnInfo { name: string; type: string; nullable: boolean; key: string }
export interface TableData { ref: string; kind: string; table: string; columns: ColumnInfo[]; primaryKey: string[]; total: number; offset: number; hasMore: boolean; rows: Record<string, unknown>[]; createStatement: string }
export interface SqlResult { mode: string; columns?: string[]; rows?: Record<string, unknown>[]; truncated?: boolean; rowCount?: number; ms?: number; committed?: string | null; dryRun?: boolean; destructive?: boolean; changes?: TableSummary[]; samples?: Record<string, { columns: string[]; rows: RowDiff[] }>; statements?: number; affectedRows?: number; note?: string }
export interface PullRequestInfo { id: number; title: string; body: string; source: string; target: string; status: 'open' | 'merged' | 'closed'; author: string; createdAt: string; mergedAt: string | null; mergeCommit: string | null }
export interface PullRequestDetail {
  preventSelfApproval?: boolean; viewer?: string; pullRequest: PullRequestInfo; comments: { id: number; author: string; kind: string; body: string; createdAt: string }[]; approvals: string[]; requiredApprovals: number;
  commits: { commit: string; author: string; date: string; message: string }[]; diff: DiffSummary | null; checks: { mergeable: boolean; reasons: string[]; conflicts: number; violations: { identity: string; roleA: string; roleB: string }[] } | null;
}

/**
 * Explorer calls. Every route needs the sign-in AND the admin capability. In the hosted demo the edge server adds the capability on its own;
 * locally the operator types it (kept in memory only, like the user token). 409 is returned as an error with the server's message.
 */
export class VersioningClient {
  adminToken = '';
  constructor(private readonly api: ApiClient) {}
  private async req<T>(method: string, path: string, body?: object): Promise<T> {
    const r = await this.api.raw<T & { message?: string }>(method, `/versioning${path}`, body, { 'x-api-admin-token': this.adminToken });
    if (r.status >= 400) throw new Error((r.data as { message?: string }).message ?? `HTTP ${r.status}`);
    return r.data;
  }
  private q(o: Record<string, string | number | boolean | undefined>) {
    const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(String(v === true ? 1 : v))}`);
    return p.length ? `?${p.join('&')}` : '';
  }
  branches() { return this.req<{ default: string; branches: BranchInfo[] }>('GET', '/branches'); }
  createBranch(name: string, from: string) { return this.req<{ branch: string; commit: string }>('POST', '/branches', { name, from }); }
  deleteBranch(name: string) { return this.req('DELETE', `/branches/${encodeURIComponent(name)}`); }
  restoreBranch(name: string, commit: string) { return this.req('POST', `/branches/${encodeURIComponent(name)}/restore`, { commit, confirm: true }); }
  tags() { return this.req<{ tags: { name: string; commit: string; date: string; message: string }[] }>('GET', '/tags'); }
  createTag(name: string, commit: string) { return this.req('POST', '/tags', { name, commit }); }
  log(ref: string, offset = 0, limit = 30) { return this.req<{ ref: string; commits: CommitInfo[]; hasMore: boolean }>('GET', `/log${this.q({ ref, offset, limit })}`); }
  commit(hash: string) { return this.req<{ commit: string; message: string; author: string; date: string; parents: string[]; changes: TableSummary[] }>('GET', `/commits/${hash}`); }
  revert(hash: string, newBranch: string) { return this.req<{ branch: string; commit: string }>('POST', `/commits/${hash}/revert`, { newBranch }); }
  diff(from: string, to: string, three: boolean) { return this.req<DiffSummary>('GET', `/diff${this.q({ from, to, three })}`); }
  diffTable(table: string, from: string, to: string, three: boolean) { return this.req<{ table: string; columns: string[]; rows: RowDiff[]; truncated: boolean }>('GET', `/diff/${table}${this.q({ from, to, three })}`); }
  tables(ref: string) { return this.req<{ ref: string; kind: string; tables: { name: string; rows: number }[] }>('GET', `/tables${this.q({ ref })}`); }
  rows(ref: string, table: string, offset = 0, limit = 25) { return this.req<TableData>('GET', `/tables/${table}${this.q({ ref, offset, limit })}`); }
  edit(branch: string, table: string, ops: object[], message: string) { return this.req<{ commit: string }>('POST', `/tables/${table}/edit`, { branch, ops, message }); }
  sql(body: { ref: string; sql: string; mode: 'read' | 'write'; message?: string; dryRun?: boolean; confirmDestructive?: boolean }) { return this.req<SqlResult>('POST', '/sql', body); }
  pulls(status?: string) { return this.req<{ pullRequests: PullRequestInfo[] }>('GET', `/pulls${this.q({ status })}`); }
  openPull(title: string, body: string, source: string, target: string) { return this.req<PullRequestInfo>('POST', '/pulls', { title, body, source, target }); }
  pull(id: number) { return this.req<PullRequestDetail>('GET', `/pulls/${id}`); }
  comment(id: number, body: string, kind: 'comment' | 'approve' = 'comment') { return this.req('POST', `/pulls/${id}/comments`, { body, kind }); }
  closePull(id: number) { return this.req('POST', `/pulls/${id}/close`, {}); }
  mergePull(id: number) { return this.req<{ commit: string }>('POST', `/pulls/${id}/merge`, {}); }
}

export const shortHash = (h: string | null | undefined) => (h ?? '').slice(0, 8);
/** Table cell text: NULL is shown as such, objects (JSON columns) as compact JSON. */
export function cellText(v: unknown): string { return v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

export interface UserProfile { id:string; display_name:string; department:string; email?:string|null; manager_id:string|null; login_enabled:boolean; hasCredential:boolean; }
