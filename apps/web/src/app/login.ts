import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RETURN_KEY, safeReturn } from './auth';
import { SigninChain, SigninOptions } from './api';
import { Session } from './session';
import { ThemeSwitch } from './theme-switch';

/** Sign-in page: lists the methods (chains) configured and enabled live, the person picks one, then the browser code+PKCE flow runs that chain. No JSON login in the UI. */
const TEST_KEY = 'iam.branch.test';

/** Reads and stashes the branch-test parameters of a test link (docs/branch-test.md). Both or neither; main is never a test. */
function testParams(q: URLSearchParams): { branch: string; ticket: string } | null {
  const branch = q.get('branch') ?? '', ticket = q.get('ticket') ?? '';
  return /^[a-z0-9-]{1,32}$/.test(branch) && branch !== 'main' && ticket.length >= 10 ? { branch, ticket } : null;
}

@Component({ selector: 'app-login', imports: [ThemeSwitch], templateUrl: './login.html', styleUrl: './login.css' })
export class LoginPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly busy = signal(false);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly signupOpen = signal(false);
  protected readonly options = signal<SigninOptions>({ mode: 'legacy', chains: [] });
  protected readonly test = signal<{ branch: string; ticket: string } | null>(null);

  constructor() {
    const t = testParams(new URLSearchParams(location.search));
    if (t) {
      // A test link opens a fresh, branch-bound session: any current sign-in ends here, explicitly.
      this.test.set(t);
      try { sessionStorage.setItem(TEST_KEY, JSON.stringify(t)); } catch { /* storage blocked: the callback will stay on main */ }
      if (this.s.loggedIn()) this.s.signOut();
      void this.load();
    } else if (this.s.loggedIn()) void this.router.navigateByUrl('/overview');
    else void this.load();
  }

  protected async load() {
    this.state.set('loading');
    try { this.signupOpen.set(!this.test() && (await fetch('/api/tenants/acme-demo/signup/schema')).ok); } catch { this.signupOpen.set(false); }
    try { this.options.set(await this.s.api.signinOptions(this.test() ?? undefined)); this.state.set('ready'); }
    catch (e) { this.error.set((e as Error).message); this.state.set('error'); }
  }
  protected stepNames(c: SigninChain) { return c.steps.map((x) => x.name).join(' \u2192 '); }

  /** Leading icon of a chain from its step types: authenticator app, e-mail code, PIN keypad, else a plain password key. */
  protected icon(c: SigninChain): 'shield' | 'mail' | 'pin' | 'key' {
    const t = c.steps.map((x) => x.type);
    if (t.some((x) => /totp|authenticator/i.test(x))) return 'shield';
    if (t.some((x) => /mail/i.test(x))) return 'mail';
    if (t.some((x) => /pin/i.test(x))) return 'pin';
    return 'key';
  }

  protected async signIn(chain?: string) {
    this.busy.set(true);
    try { await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u), chain, this.test() ?? undefined); }
    catch (e) { this.s.say((e as Error).message, 'error'); this.busy.set(false); }
  }
}

/** Return URL of the sign-in redirect (/callback): checks state + PKCE verifier, then goes back to the page the user came from. */
@Component({ selector: 'app-callback', template: '<div class="wait"><p>Completing sign-in...</p></div>', styles: ['.wait { display:grid; place-items:center; min-height:100vh; color:#64748b }'] })
export class CallbackPage {
  private readonly s = inject(Session);
  private readonly router = inject(Router);
  constructor() { void this.finish(); }
  private async finish() {
    const search = location.search; // the code never stays in the address bar or history: the router replaces the URL below
    try {
      await this.s.api.completeBrowserLogin(search, sessionStorage);
      this.s.signedIn(); this.s.say('Signed in through the browser flow (code + PKCE, state checked). In-memory token.');
      // Branch test: the token is bound to the branch by the core; the console now sends it on every call and shows the banner.
      try {
        const raw = sessionStorage.getItem(TEST_KEY); sessionStorage.removeItem(TEST_KEY);
        const t = raw ? (JSON.parse(raw) as { branch?: unknown }) : null;
        if (t && typeof t.branch === 'string' && /^[a-z0-9-]{1,32}$/.test(t.branch) && t.branch !== 'main') {
          this.s.enterBranchTest(t.branch);
          this.s.say(`Testing data branch ${t.branch}: sign-in and the app use it until you exit the test.`);
        }
      } catch { /* a broken stash never blocks the sign-in */ }
      await this.s.refresh().catch(() => undefined);
      const back = safeReturn(sessionStorage.getItem(RETURN_KEY)); sessionStorage.removeItem(RETURN_KEY);
      await this.router.navigateByUrl(this.s.testBranch() ? '/my-profile' : back, { replaceUrl: true });
    } catch (e) {
      this.s.say((e as Error).message, 'error');
      await this.router.navigateByUrl('/login', { replaceUrl: true });
    }
  }
}
