import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { RETURN_KEY, safeReturn } from './auth';
import { Session } from './session';

/** Sign-in page: the browser code+PKCE flow (recommended) and the legacy JSON login kept as a diagnostic. */
@Component({ selector: 'app-login', imports: [FormsModule], templateUrl: './login.html', styleUrl: './login.css' })
export class LoginPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected readonly user = signal('demo-alice');
  protected password = '';
  protected readonly busy = signal(false);

  constructor() { if (this.s.loggedIn()) void this.router.navigateByUrl('/overview'); }

  protected async signIn() {
    this.busy.set(true);
    try { await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u)); }
    catch (e) { this.s.say((e as Error).message, 'error'); this.busy.set(false); }
  }

  protected async legacy() {
    try {
      await this.s.api.login(this.user(), this.password); this.password = '';
      this.s.signedIn(this.user()); this.s.say('Signed in with the legacy JSON flow (in-memory token).');
      await this.s.refresh().catch(() => undefined);
      await this.router.navigateByUrl(safeReturn(sessionStorage.getItem(RETURN_KEY)));
    } catch (e) { this.s.say((e as Error).message, 'error'); }
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
