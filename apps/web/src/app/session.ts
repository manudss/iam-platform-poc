import { Injectable, OnDestroy, REQUEST, inject, signal } from '@angular/core';
import { ApiClient, Change, sessionCookieToken } from './api';
import { computed } from '@angular/core';
import type { Access } from './access';
import { Router } from '@angular/router';

export type Tone = 'info' | 'error';
export interface Assignment { identity_id: string; role_id: string }
export interface Activation { seq: number; commit: string }

/**
 * State shared by all pages of the console: the API client (token kept across visits while valid, docs/session.md), the signed-in flag, the last
 * message shown in the status bar and the data of the IAM pages. Pages never keep their own copy of the token.
 */
@Injectable({ providedIn: 'root' })
export class Session implements OnDestroy {
  private readonly router = inject(Router);
  readonly expired = signal(false);
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private tick?: ReturnType<typeof setInterval>;
  /** Clock of the session timer (updated every second while signed in). */
  readonly now = signal(Date.now());
  /** Timing of the current token (docs/session.md); null without a token or when the token carries no times. */
  readonly timing = signal<{ start: number; end: number; warnMs: number; limit: number | null } | null>(null);
  readonly remainingMs = computed(() => { const t = this.timing(); return t ? Math.max(0, t.end - this.now()) : 0; });
  /** Share of this token's lifetime that is left (1 = just issued, 0 = over): drives the inverted progress bar. */
  readonly remainingShare = computed(() => { const t = this.timing(); return t && t.end > t.start ? Math.min(1, this.remainingMs() / (t.end - t.start)) : 0; });
  /** Renewal is possible while the absolute limit is later than the end of this token. */
  readonly canExtend = computed(() => { const t = this.timing(); return !!t && t.limit !== null && t.limit > t.end; });
  readonly dismissed = signal(false);
  readonly extending = signal(false);
  /** True in the last `warnMs` before the end of the token: the console shows the warning dialog. */
  readonly warning = computed(() => { const t = this.timing(); return !!this.loggedIn() && !!t && this.remainingMs() > 0 && this.remainingMs() <= t.warnMs && !this.dismissed(); });
  /** Renews the session token. Returns a message for the person when it could not be done. */
  async extend(): Promise<string> {
    if (this.extending()) return '';
    this.extending.set(true);
    try {
      const r = await this.api.extendSession();
      if (r === 'extended') { this.refreshTiming(); this.dismissed.set(false); this.scheduleExpiry(); this.say('Session extended.'); return ''; }
      if (r === 'limit') { this.refreshTiming(); return 'The maximum session length is reached: it cannot be extended. Sign in again after it ends.'; }
      this.expire(); return '';
    } catch { return 'The session could not be extended. Try again.'; }
    finally { this.extending.set(false); }
  }
  private refreshTiming() { this.timing.set(this.api.sessionInfo); this.now.set(Date.now()); }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const expires = this.api.expiresAt;
    if (expires !== null) this.expiryTimer = setTimeout(() => this.expire(), Math.max(0, expires - Date.now()));
  }
  readonly api = new ApiClient('acme-demo', (...args) => fetch(...args), () => this.expire());
  constructor() {
    // SSR: the session cookie (docs/session.md) is the only token source - there is no localStorage here.
    // The render then answers with the signed-in page directly instead of bouncing to sign-in.
    const req = inject(REQUEST, { optional: true });
    if (req) { const t = sessionCookieToken(req.headers.get('cookie') ?? ''); if (t && this.api.adoptServer(t)) this.signedIn(); }
    else if (this.api.restore()) this.signedIn(); // a visit within the token's lifetime skips a new sign-in
  }
  readonly loggedIn = signal(false);
  readonly user = signal('');
  readonly branch = signal('');
  readonly branchEpoch = signal(0);
  /** Data branch under test (docs/branch-test.md): set from the sign-in callback of a test link, cleared at sign-out. */
  readonly testBranch = signal('');
  /** Enters the branch-test mode after a test sign-in: every API call carries the branch and the shell shows the test banner. */
  enterBranchTest(branch: string) { this.testBranch.set(branch); this.selectBranch(branch); }
  selectBranch(branch:string){this.api.branch=branch;this.branch.set(branch);this.branchEpoch.update(x=>x+1);this.change.set(null);this.assignments.set([]);this.activations.set([]);}

  readonly message = signal('');
  readonly tone = signal<Tone>('info');
  /** Admin capability token typed by the operator (local setups only; the hosted edge injects it server-side). Memory only. */
  readonly adminToken = signal('');
  readonly assignments = signal<Assignment[]>([]);
  readonly activations = signal<Activation[]>([]);
  readonly change = signal<Change | null>(null);

  /** Feature flags from the plugin registry (workflows-iga gates the Workflows feature). Refreshed by the shell; bumped via pluginsVersion after enable/disable. */
  readonly pluginsVersion = signal(0);
  readonly workflowsEnabled = signal<boolean | null>(null);
  private pluginsLoadedAt = 0;
  async refreshWorkflowsEnabled(force = false): Promise<boolean> {
    if (!force && this.workflowsEnabled() !== null && Date.now() - this.pluginsLoadedAt < 15000) return this.workflowsEnabled()!;
    try {
      const r = await this.api.raw<{ plugins: { id: string; enabled: boolean }[] }>('GET', '/plugins');
      const on = !!r.data.plugins?.find((p) => p.id === 'workflows-iga')?.enabled;
      this.workflowsEnabled.set(on); this.pluginsLoadedAt = Date.now();
      return on;
    } catch { return this.workflowsEnabled() ?? false; }
  }
  readonly access = signal<Access | null>(null);
  private accessLoad?: Promise<Access>;
  /** Loaded once per sign-in. If it cannot be read the person is treated as ordinary (nothing is revealed that the API would refuse). */
  loadAccess(): Promise<Access> {
    return this.accessLoad ??= this.api.raw<Access>('GET', '/me/access', undefined, this.adminToken() ? { 'x-api-admin-token': this.adminToken() } : {}).then((r) => (r.status < 400 ? r.data : { subject: '', admin: false, restricted: true, plugins: {} })).catch(() => ({ subject: '', admin: false, restricted: true, plugins: {} } as Access)).then((a) => { const n = { ...a, plugins: a.plugins ?? {} }; this.access.set(n); return n; });
  }
  refreshAccess() { this.accessLoad = undefined; return this.loadAccess(); }
  ngOnDestroy() { clearTimeout(this.expiryTimer); clearInterval(this.tick); }

  say(text: string, tone: Tone = 'info') { this.message.set(text); this.tone.set(tone); }

  /** Marks the session signed in after a successful token exchange (browser or legacy flow). */
  signedIn(fallbackName = '') {
    this.expired.set(false); this.loggedIn.set(true); this.user.set(this.api.identity || fallbackName);
    this.dismissed.set(false); this.refreshTiming(); this.scheduleExpiry();
    clearInterval(this.tick); if (this.timing()) this.tick = setInterval(() => this.now.set(Date.now()), 1000);
  }

  /** No request is queued or replayed. Returning to a page requires a fresh, explicit action. */
  expire() {
    if (!this.loggedIn()) return;
    const path = this.router.url;
    try { if (path !== '/login' && !path.startsWith('/callback')) sessionStorage.setItem('iam.return', path); } catch { /* storage blocked */ }
    this.signOut();
    this.say('', 'info');
    this.expired.set(true);
    void this.router.navigateByUrl('/login', { replaceUrl: true });
  }

  signOut() {
    this.expired.set(false); clearTimeout(this.expiryTimer); clearInterval(this.tick); this.timing.set(null); this.dismissed.set(false);
    this.api.logout();this.accessLoad = undefined; this.access.set(null);this.selectBranch(''); this.testBranch.set(''); this.loggedIn.set(false); this.user.set(''); this.change.set(null);
    this.assignments.set([]); this.activations.set([]); this.adminToken.set(''); this.say('Signed out.');
  }

  async refresh() { this.assignments.set(await this.api.assignments()); this.activations.set(await this.api.activations()); }
}
