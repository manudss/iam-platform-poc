import { isPlatformBrowser } from '@angular/common';
import { Component, PLATFORM_ID, PendingTasks, TransferState, effect, inject, makeStateKey, signal } from '@angular/core';
import { Session } from './session';

export interface LaunchpadApp { id: string; name: string; description: string; protocol: 'oidc' | 'saml'; url: string }

/** Hydration handoff: the applications the server fetched to render this page, so the browser does not refetch them (and flash "Loading...") on startup. */
const LAUNCHPAD_KEY = makeStateKey<{ user?: { name?: string }; apps?: LaunchpadApp[] }>('iam-launchpad');

/** Home of the signed-in console: the applications this person's roles open, one click away through single
 *  sign-on. SAML applications launch IdP-initiated (the IdP posts the assertion to the application); OIDC
 *  applications launch on their own URL and their sign-in flow rides the session already open here. */
@Component({
  selector: 'app-launchpad', styleUrl: './pages.css',
  template: `
  <p class="lead">Welcome{{userName() ? ', ' + userName() : ''}}. Your applications open through single sign-on with your current session. Fictional demo only: every application below is fictional.</p>
  @if (problem()) { <p role="alert" class="msg bad" id="lp-problem">{{problem()}}</p> }
  <div class="lp-grid" id="lp-grid">
    @for (a of apps(); track a.id) {
      <a class="card lp-card" [href]="a.url" [attr.data-app]="a.id">
        <span class="lp-head"><b>{{a.name}}</b><span class="pill lp-proto">{{a.protocol === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}}</span></span>
        <span class="lp-desc">{{a.description}}</span>
        <span class="lp-open">Open with SSO →</span>
      </a>
    } @empty {
      @if (loaded() && !problem()) { <p class="hint" id="lp-empty">No application is open to your roles yet. An administrator grants access from the Applications page.</p> }
      @if (!loaded()) { <p class="hint">Loading…</p> }
    }
  </div>`,
})
export class LaunchpadPage {
  protected readonly s = inject(Session);
  protected apps = signal<LaunchpadApp[]>([]);
  protected userName = signal('');
  protected problem = signal('');
  protected loaded = signal(false);
  /** SSR: the launchpad renders on the server (docs/session.md, the session cookie). The tracked load lets the
   *  server render wait for the applications, so the first HTML already carries them. */
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly pending = inject(PendingTasks);
  private readonly transfer = inject(TransferState);
  constructor() { effect(() => { this.s.branchEpoch(); void this.pending.run(() => this.load()); }); }
  private async load() {
    // Hydration: reuse what the server fetched to render this very page instead of refetching it.
    if (this.isBrowser && this.transfer.hasKey(LAUNCHPAD_KEY)) {
      const d = this.transfer.get(LAUNCHPAD_KEY, {});
      this.apps.set(Array.isArray(d.apps) ? d.apps : []);
      this.userName.set(d.user?.name ?? '');
      this.problem.set('');
      this.transfer.remove(LAUNCHPAD_KEY);
      this.loaded.set(true);
      return;
    }
    try {
      const r = await this.s.api.raw<{ user?: { name?: string }; apps?: LaunchpadApp[] }>('GET', '@/sso/{t}/launchpad');
      this.apps.set(Array.isArray(r.data?.apps) ? r.data.apps : []);
      this.userName.set(r.data?.user?.name ?? '');
      this.problem.set('');
      if (!this.isBrowser) this.transfer.set(LAUNCHPAD_KEY, r.data ?? {});
    } catch (e) { this.problem.set((e as Error).message); } finally { this.loaded.set(true); }
  }
}
