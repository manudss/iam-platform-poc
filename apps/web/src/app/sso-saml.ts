import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { SamlRequest } from './api';
import { Session } from './session';

/** What a SAML attribute means for the person, in plain words. Unknown attribute names are shown as they are. */
export const ATTR_TEXT: Record<string, string> = {
  NameID: 'recognise you (your account identifier)',
  givenName: 'your name',
  displayName: 'your name',
  email: 'your email address',
  mail: 'your email address',
  department: 'your department',
  roles: 'your roles in the company',
  groups: 'your groups',
};
export const describeAttributes = (names: string[]) => names.map((n) => ATTR_TEXT[n] ?? n);

/**
 * Sign-in request of a SAML application (plugin `saml-idp`). The route is behind the console sign-in, so by the time it shows
 * the person has gone through the normal authentication chain. On Allow the API hands back a signed SAMLResponse and this page
 * posts it to the application's assertion consumer service, as the SAML POST binding prescribes.
 */
@Component({
  selector: 'app-sso-saml',
  template: `
  <main class="sso">
    @if (state() === 'loading') { <p>Loading the sign-in request...</p> }
    @else if (state() === 'done') { <p>Sending your sign-in to the application...</p> }
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
  styles: ['.sso{max-width:34rem;margin:10vh auto;padding:1.5rem;font:16px system-ui;color:var(--ink)}.row{display:flex;gap:.75rem;margin-top:1rem}.hint{color:var(--muted);font-size:.9rem}button{padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:var(--accent);color:var(--card);cursor:pointer}button.secondary{background:var(--line);color:var(--ink)}button[disabled]{opacity:.6}'],
})
export class SsoSamlPage {
  private readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  protected readonly state = signal<'loading' | 'ready' | 'done' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly req = signal<SamlRequest | null>(null);
  private rid = this.route.snapshot.paramMap.get('rid') ?? '';

  constructor() { void this.load(); }
  protected texts(r: SamlRequest) { return describeAttributes(r.attributes); }
  private async load() {
    try { this.req.set(await this.s.api.samlRequest(this.rid)); this.state.set('ready'); }
    catch (e) { this.error.set((e as Error).message); this.state.set('error'); }
  }
  protected async answer(d: 'allow' | 'deny') {
    this.busy.set(true);
    try {
      const r = await this.s.api.samlAnswer(this.rid, d);
      this.state.set('done');
      const f = document.createElement('form'); f.method = 'post'; f.action = r.acsUrl; f.style.display = 'none';
      const add = (n: string, v: string) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; f.appendChild(i); };
      add('SAMLResponse', r.samlResponse); if (r.relayState) add('RelayState', r.relayState);
      document.body.appendChild(f); f.submit();
    } catch (e) { this.error.set((e as Error).message); this.state.set('error'); this.busy.set(false); }
  }
}
