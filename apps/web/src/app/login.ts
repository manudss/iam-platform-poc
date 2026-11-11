import { Brand, Branding } from './branding';
import { Component, PLATFORM_ID, PendingTasks, REQUEST, TransferState, inject, makeStateKey, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { RETURN_KEY, safeReturn } from './auth';
import { SigninChain, SigninOptions, apiUrl } from './api';

/** Hydration handoff: the options the server fetched to render /login, so the browser does not refetch them (and flash "Loading...") on startup. */
const OPTIONS_KEY = makeStateKey<SigninOptions>('iam-signin-options');
const SIGNUP_KEY = makeStateKey<boolean>('iam-signup-open');
import { Session } from './session';
import { Theme } from './theme';
import { ThemeSwitch } from './theme-switch';

/** Sign-in page: lists the methods (chains) configured and enabled live, the person picks one, then the browser code+PKCE flow runs that chain. No JSON login in the UI. */
const TEST_KEY = 'iam.branch.test';

/** Reads and stashes the branch-test parameters of a test link (docs/branch-test.md). Both or neither; main is never a test. */
function testParams(q: URLSearchParams): { branch: string; ticket: string } | null {
  const branch = q.get('branch') ?? '', ticket = q.get('ticket') ?? '';
  return /^(?:[a-z0-9-]{1,16}\/)?[a-z0-9-]{1,54}$/.test(branch) && branch !== 'main' && ticket.length >= 10 ? { branch, ticket } : null;
}

/** True only for /login?preview=1 inside a frame. A top-level visit with the parameter behaves as a normal sign-in page. */
export function isPreview(): boolean { try { return new URLSearchParams(location.search).get('preview') === '1' && window.parent !== window; } catch { return false; } }

/** Validates the message sent by the admin page. Anything else is ignored. */
export function previewMessage(d: unknown): { chains: SigninChain[]; highlight: string; view: 'list' | 'step'; step: number; dark: boolean } | null {
  const x = d as Record<string, unknown> | null;
  if (!x || x['type'] !== 'iam-preview' || !Array.isArray(x['chains'])) return null;
  const chains = (x['chains'] as SigninChain[]).filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.steps)).slice(0, 50);
  return { chains, highlight: typeof x['highlight'] === 'string' ? x['highlight'] : '', view: x['view'] === 'step' ? 'step' : 'list', step: Math.max(0, Number(x['step']) || 0), dark: x['dark'] === true };
}

@Component({ selector: 'app-login', imports: [ThemeSwitch, Brand], templateUrl: './login.html', styleUrl: './login.css' })
export class LoginPage {
  protected readonly s = inject(Session);
  protected readonly branding = inject(Branding);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly busy = signal(false);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly signupOpen = signal(false);
  protected readonly options = signal<SigninOptions>({ mode: 'legacy', chains: [] });
  protected readonly test = signal<{ branch: string; ticket: string } | null>(null);
  /** A branch test can create its own test account (on that branch only): the same ticket, carried to the sign-up page. */
  protected testSignupUrl() { const t = this.test(); return t ? `/signup?branch=${encodeURIComponent(t.branch)}&ticket=${encodeURIComponent(t.ticket)}` : '/signup'; }

  /** Preview mode: only when embedded in a frame (the admin "Preview"). Renders chains posted by the same origin; no API call, no sign-in, nothing sent. */
  protected readonly preview = signal(isPreview());
  protected readonly pview = signal<'list' | 'step'>('list');
  protected readonly pstep = signal(0);
  protected readonly highlight = signal('');
  private readonly theme = inject(Theme);
  /** SSR: the login page renders on the server. Browser globals stay behind this flag; the tracked load lets
   *  the server render wait for the methods list, so the first HTML already carries it. */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly pending = inject(PendingTasks);
  private readonly transfer = inject(TransferState);

  constructor() {
    if (this.preview()) {
      this.options.set({ mode: 'choice', chains: [] }); this.state.set('ready');
      addEventListener('message', (ev) => this.onPreviewMessage(ev));
      parent.postMessage({ type: 'iam-preview-ready' }, location.origin);
      return;
    }
    const t = testParams(new URLSearchParams(this.isBrowser ? location.search : ''));
    // Server-side with a session cookie, /login?preview=1 (the admin branding frame) must still render the
    // page instead of bouncing to the console: the frame test needs the frame itself, which only the browser
    // knows, so the query is honored as is.
    const serverPreview = (() => { try { return new URL(inject(REQUEST, { optional: true })?.url ?? 'http://localhost/login').searchParams.get('preview') === '1'; } catch { return false; } })();
    if (t) {
      // A test link opens a fresh, branch-bound session: any current sign-in ends here, explicitly.
      this.test.set(t);
      try { sessionStorage.setItem(TEST_KEY, JSON.stringify(t)); } catch { /* storage blocked: the callback will stay on main */ }
      if (this.s.loggedIn()) this.s.signOut();
      void this.pending.run(() => this.load());
    // Already signed in: go to the launchpad's own route. The hosted edge redirects '/' to this page,
    // so authenticated visitors must land on a real console page instead of returning to '/'.
    } else if (this.s.loggedIn() && !serverPreview) void this.router.navigateByUrl('/my-applications');
    else void this.pending.run(() => this.load());
  }

  private onPreviewMessage(ev: MessageEvent) {
    if (ev.origin !== location.origin || ev.source !== parent) return;
    if (this.branding.preview(ev.data)) {this.theme.mode.set((ev.data as any).dark ? 'dark' : 'light'); if(!this.options().chains.length)this.options.set({mode:'legacy',chains:[]}); return;}
    const m = previewMessage(ev.data); if (!m) return;
    this.options.set({ mode: 'choice', chains: m.chains }); this.highlight.set(m.highlight); this.pview.set(m.view); this.pstep.set(m.step);
    this.theme.mode.set(m.dark ? 'dark' : 'light'); // not persisted: the admin theme is untouched
  }
  protected previewChain() { const c = this.options().chains; return c.find((x) => x.id === this.highlight()) ?? c[0]; }
  protected previewStepOf() { const c = this.previewChain(); return c?.steps[Math.min(this.pstep(), (c?.steps.length ?? 1) - 1)]; }
  protected stepKind(type: string): 'password' | 'code' | 'pin' | 'other' { return /pin|digit/i.test(type) ? 'pin' : /totp|authenticator|otp|mail/i.test(type) ? 'code' : /password/i.test(type) ? 'password' : 'other'; }

  protected async load() {
    // Hydration: reuse what the server fetched to render this very page instead of refetching - the
    // server-rendered list must not be replaced by a "Loading..." line while the same answer comes back.
    // A branch-test link is bound to its own branch and always fetches live.
    if (this.isBrowser && !this.test() && this.transfer.hasKey(OPTIONS_KEY)) {
      this.options.set(this.transfer.get(OPTIONS_KEY, { mode: 'legacy', chains: [] }));
      this.signupOpen.set(this.transfer.get(SIGNUP_KEY, false));
      this.transfer.remove(OPTIONS_KEY); this.transfer.remove(SIGNUP_KEY);
      this.state.set('ready');
      return;
    }
    this.state.set('loading');
    // The two startup calls run in parallel: the list no longer waits for the sign-up schema answer.
    const signup = async () => {
      try { this.signupOpen.set(!this.test() && (await fetch(apiUrl('/api/tenants/acme-demo/signup/schema'))).ok); } catch { this.signupOpen.set(false); }
      if (!this.isBrowser) this.transfer.set(SIGNUP_KEY, this.signupOpen());
    };
    const options = async () => {
      try {
        const o = await this.s.api.signinOptions(this.test() ?? undefined);
        this.options.set(o); this.state.set('ready');
        if (!this.isBrowser && !this.test()) this.transfer.set(OPTIONS_KEY, o);
      } catch (e) { this.error.set((e as Error).message); this.state.set('error'); }
    };
    await Promise.all([signup(), options()]);
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
    if (this.preview()) return; // preview: no sign-in, nothing sent
    this.busy.set(true);
    try { await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u), chain, this.test() ?? undefined); }
    catch (e) { this.s.say((e as Error).message, 'error'); this.busy.set(false); }
  }
}

/** Return URL of the sign-in redirect (/callback): checks state + PKCE verifier, then goes back to the page the user came from. */
@Component({ selector: 'app-callback', template: '<div class="wait"><p>Completing sign-in...</p></div>', styles: ['.wait { display:grid; place-items:center; min-height:100vh; color:var(--muted) }'] })
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
        if (t && typeof t.branch === 'string' && /^(?:[a-z0-9-]{1,16}\/)?[a-z0-9-]{1,54}$/.test(t.branch) && t.branch !== 'main') {
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
