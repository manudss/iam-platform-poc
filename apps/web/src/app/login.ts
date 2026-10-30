import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { RETURN_KEY, safeReturn } from './auth';
import { SigninChain, SigninOptions } from './api';
import { Session } from './session';

/** Sign-in page: lists the methods (chains) configured and enabled live, the person picks one, then the browser code+PKCE flow runs that chain. No JSON login in the UI. */
@Component({ selector: 'app-login', templateUrl: './login.html', styleUrl: './login.css' })
export class LoginPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected readonly busy = signal(false);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly signupOpen = signal(false);
  protected readonly options = signal<SigninOptions>({ mode: 'legacy', chains: [] });

  constructor() { if (this.s.loggedIn()) void this.router.navigateByUrl('/overview'); else void this.load(); }

  protected async load() {
    this.state.set('loading');
    try { this.signupOpen.set((await fetch('/api/tenants/acme-demo/signup/schema')).ok); } catch { this.signupOpen.set(false); }
    try { this.options.set(await this.s.api.signinOptions()); this.state.set('ready'); }
    catch (e) { this.error.set((e as Error).message); this.state.set('error'); }
  }
  protected stepNames(c: SigninChain) { return c.steps.map((x) => x.name).join(' \u2192 '); }

  protected async signIn(chain?: string) {
    this.busy.set(true);
    try { await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u), chain); }
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
      await this.s.refresh().catch(() => undefined);
      const back = safeReturn(sessionStorage.getItem(RETURN_KEY)); sessionStorage.removeItem(RETURN_KEY);
      await this.router.navigateByUrl(back, { replaceUrl: true });
    } catch (e) {
      this.s.say((e as Error).message, 'error');
      await this.router.navigateByUrl('/login', { replaceUrl: true });
    }
  }
}
