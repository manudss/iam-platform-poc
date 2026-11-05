import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { SsoRequest } from './api';
import { Session } from './session';

/** What each OpenID Connect scope means for the person, in plain words. Unknown scopes are not listed (the server never grants them). */
export const SCOPE_TEXT: Record<string, string> = {
  openid: 'recognise you (your account identifier)',
  profile: 'your name and department',
  email: 'your email address',
  roles: 'your roles in the company',
  offline_access: 'stay signed in without asking you again',
};
export const describeScopes = (scopes: string[]) => scopes.filter((s) => s in SCOPE_TEXT).map((s) => SCOPE_TEXT[s]);

/**
 * Sign-in request of an application (OIDC provider, plugin `oidc-provider`). The route is behind the console sign-in, so by the time it shows
 * the person has gone through the normal authentication chain. The page names the application and what it receives, then the person allows or declines.
 */
@Component({
  selector: 'app-sso-interaction',
  template: `
  <main class="sso">
    @if (state() === 'loading') { <p>Loading the sign-in request...</p> }
    @else if (state() === 'error') { <h1>This sign-in request cannot be completed</h1><p role="alert" id="sso-error">{{error()}}</p><p>Go back to the application and start again.</p> }
    @else if (req(); as r) {
      <h1>{{r.app.name}} asks to sign you in</h1>
      <p>Signed in as <b>{{r.user.name}}</b>.</p>
      @if (r.allowed) {
        <p>If you allow it, <b>{{r.app.name}}</b> receives:</p>
        <ul id="sso-scopes">@for (t of texts(r); track t) { <li>{{t}}</li> }</ul>
        <p class="hint">Your password and authentication codes are never shared with the application.</p>
        <div class="row"><button id="sso-allow" [disabled]="busy()" (click)="answer('allow')">Allow</button><button id="sso-deny" class="secondary" [disabled]="busy()" (click)="answer('deny')">Cancel</button></div>
      } @else {
        <p role="alert" id="sso-refused">Your account is not allowed to open <b>{{r.app.name}}</b>. Ask an administrator if you need access.</p>
        <div class="row"><button id="sso-deny" class="secondary" [disabled]="busy()" (click)="answer('deny')">Back to the application</button></div>
      }
    }
  </main>`,
  styles: ['.sso{max-width:34rem;margin:10vh auto;padding:1.5rem;font:16px system-ui;color:#1e293b}.row{display:flex;gap:.75rem;margin-top:1rem}.hint{color:#64748b;font-size:.9rem}button{padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#4f46e5;color:#fff;cursor:pointer}button.secondary{background:#e2e8f0;color:#1e293b}button[disabled]{opacity:.6}'],
})
export class SsoInteractionPage {
  private readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly req = signal<SsoRequest | null>(null);
  private uid = this.route.snapshot.paramMap.get('uid') ?? '';

  constructor() { void this.load(); }
  protected texts(r: SsoRequest) { return describeScopes(r.scopes); }
  private async load() {
    try { this.req.set(await this.s.api.ssoRequest(this.uid)); this.state.set('ready'); }
    catch (e) { this.error.set((e as Error).message); this.state.set('error'); }
  }
  protected async answer(d: 'allow' | 'deny') {
    this.busy.set(true);
    try { const r = await this.s.api.ssoAnswer(this.uid, d); location.assign(r.redirectTo); }
    catch (e) { this.error.set((e as Error).message); this.state.set('error'); this.busy.set(false); }
  }
}
