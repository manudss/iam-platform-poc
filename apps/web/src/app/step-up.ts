import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from './session';
import { RETURN_KEY, safeReturn } from './auth';
import { Brand, Branding } from './branding';
import { ThemeSwitch } from './theme-switch';
import { SigninMethods } from './signin-methods';
import { SigninChain } from './api';

export const STEP_UP_SUBJECT_KEY = 'iam.stepup.subject';

/** What to say on the re-sign-in page: pure, so the wording and the "never offer a weaker method" rule are tested without a browser. */
export function stepUpView(a: { kind: string; app: string; required: number; current: number; chains: SigninChain[] }) {
  const admin = a.kind === 'admin';
  const title = admin ? `Administration needs level ${a.required}` : `${a.app || 'This application'} requires a stronger sign-in`;
  const detail = admin
    ? `Your sign-in is at level ${a.current}. Sign in again with a stronger method to open the admin pages. The rest of your session stays valid.`
    : `You are signed in at level ${a.current}. This application needs level ${a.required} or more.`;
  // Only methods that reach the level and that the person has set up. Nothing weaker is ever listed.
  const chains = a.chains.filter((c) => c.effectiveLevel >= a.required).sort((x, y) => x.effectiveLevel - y.effectiveLevel);
  return { title, detail, chains, none: chains.length === 0 };
}

/**
 * Re-sign-in page. Reached when an application or the administration pages need a stronger sign-in than the current one.
 * The methods show exactly as on the main sign-in page (same shared rows), filtered to those that reach the level and
 * that this person can complete; when there is none it says so and points to the profile.
 */
@Component({
  selector: 'app-step-up',
  imports: [ThemeSwitch, Brand, SigninMethods],
  styleUrl: './login.css',
  template: `
  <div class="auth-bg" aria-hidden="true"><img src="https://picsum.photos/1920/1080" alt="" loading="eager"></div>
  <div class="auth-veil" aria-hidden="true"></div>
  <app-theme-switch class="auth-theme" />
  <main class="login">
  <section class="card hero">
    <div class="brand"><h1 class="brand-title"><app-brand /></h1></div>
    @if (loading()) { <p class="lead">Checking which sign-in methods reach the level...</p> }
    @else if (error()) { <p class="msg error" role="alert" id="su-error">{{error()}}</p><button type="button" class="secondary" (click)="cancel()">Go back</button> }
    @else {
      @if (view().none) {
        <div class="alert-err" role="alert" id="su-none"><div><b>No eligible sign-in method</b><br>{{required()}} or more is needed (level), and you have not set up a method that reaches it yet. Add an authenticator app or a passkey in your profile, then try again.</div></div>
        <button type="button" class="primary" id="su-profile" (click)="profile()">Open my security settings</button>
      } @else {
        <p class="msg" id="su-reason" role="status"><b>{{view().title}}</b><br>{{view().detail}}</p>
        <app-signin-methods [chains]="view().chains" [busy]="busy()" (pick)="go($event)" />
      }
      <button type="button" class="secondary wide" id="su-cancel" (click)="cancel()">Cancel and go back</button>
    }
    <p class="foot">{{branding.profile().footer}} <a href="/privacy">Politique de confidentialité / Privacy</a> · <a href="/about">About this demo</a></p>
  </section>
  </main>`,
  styles: ['.wide { width: 100%; margin-top: .8rem; }'],
})
export class StepUpPage {
  private readonly s = inject(Session);
  protected readonly branding = inject(Branding);
  private readonly router = inject(Router);
  private readonly q = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly chains = signal<SigninChain[]>([]);
  protected readonly required = signal(Math.min(10, Math.max(0, Number(this.q.get('level')) || 0)));
  private readonly back = safeReturn(this.q.get('return'));
  protected view() { return stepUpView({ kind: this.q.get('kind') ?? 'app', app: (this.q.get('app') ?? '').slice(0, 60), required: this.required(), current: Math.max(0, Number(this.q.get('current')) || 0), chains: this.chains() }); }
  constructor() { void this.load(); }
  private async load() {
    try { this.chains.set((await this.s.api.raw<{ chains: SigninChain[] }>('GET', `/auth/me/step-up?level=${this.required()}`)).data.chains ?? []); }
    catch (e) { this.error.set((e as Error).message); }
    this.loading.set(false);
  }
  protected async go(chain: string) {
    this.busy.set(true);
    try {
      sessionStorage.setItem(RETURN_KEY, this.back);
      sessionStorage.setItem(STEP_UP_SUBJECT_KEY, (await this.s.loadAccess().catch(() => null))?.subject ?? '');
    } catch { /* storage blocked: the launchpad is the landing page after sign-in */ }
    await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u), chain);
  }
  protected cancel() { void this.router.navigateByUrl('/my-applications'); }
  protected profile() { void this.router.navigateByUrl('/my-profile'); }
}
