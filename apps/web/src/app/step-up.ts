import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from './session';
import { RETURN_KEY, safeReturn } from './auth';

export const STEP_UP_SUBJECT_KEY = 'iam.stepup.subject';

export interface StepUpChain { id: string; name: string; level: number }
/** What to say on the re-sign-in page: pure, so the wording and the "never offer a weaker method" rule are tested without a browser. */
export function stepUpView(a: { kind: string; app: string; required: number; current: number; chains: StepUpChain[] }) {
  const admin = a.kind === 'admin';
  const title = admin ? `Administration needs level ${a.required}` : `${a.app || 'This application'} requires a stronger sign-in`;
  const detail = admin
    ? `Your sign-in is at level ${a.current}. Sign in again with a stronger method to open the admin pages. The rest of your session stays valid.`
    : `You are signed in at level ${a.current}. This application needs level ${a.required} or more.`;
  // Only methods that reach the level and that the person has set up. Nothing weaker is ever listed.
  const chains = a.chains.filter((c) => c.level >= a.required).sort((x, y) => x.level - y.level);
  return { title, detail, chains, none: chains.length === 0 };
}

/**
 * Re-sign-in page. Reached when an application or the administration pages need a stronger sign-in than the current one.
 * It lists only the methods that reach the level and that this person can complete; when there is none it says so and points to the profile.
 */
@Component({
  selector: 'app-step-up',
  template: `
  <main class="su">
    <div class="logo">lyam</div>
    @if (loading()) { <p>Checking which sign-in methods reach the level…</p> }
    @else if (error()) { <p role="alert" class="bad" id="su-error">{{error()}}</p><button class="secondary" (click)="cancel()">Go back</button> }
    @else {
      @if (view().none) {
        <div class="alert" role="alert" id="su-none"><strong>No eligible sign-in method</strong><span>{{required()}} or more is needed (level), and you have not set up a method that reaches it yet. Add an authenticator app or a passkey in your profile, then try again.</span></div>
        <button id="su-profile" (click)="profile()">Open my security settings</button>
      } @else {
        <div class="alert info" id="su-reason"><strong>{{view().title}}</strong><span>{{view().detail}}</span></div>
        @for (c of view().chains; track c.id) { <button class="opt" [id]="'su-' + c.id" [disabled]="busy()" (click)="go(c)"><b>{{c.name}}</b><span>Level {{c.level}}</span></button> }
      }
      <button class="secondary" id="su-cancel" (click)="cancel()">Cancel and go back</button>
    }
  </main>`,
  styles: ['.su{max-width:30rem;margin:10vh auto;padding:1.5rem;font:16px system-ui;color:var(--ink);display:grid;gap:.75rem}.logo{font-weight:700;font-size:1.4rem}.alert{display:grid;gap:.25rem;padding:.8rem 1rem;border-radius:.5rem;background:var(--bad-soft);color:var(--bad-ink)}.alert.info{background:var(--card);border:1px solid var(--line);color:var(--ink)}.opt{display:flex;justify-content:space-between;align-items:center;text-align:left}button{padding:.6rem 1.2rem}.bad{color:var(--bad-ink)}'],
})
export class StepUpPage {
  private readonly s = inject(Session);
  private readonly router = inject(Router);
  private readonly q = inject(ActivatedRoute).snapshot.queryParamMap;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly chains = signal<StepUpChain[]>([]);
  protected readonly required = signal(Math.min(10, Math.max(0, Number(this.q.get('level')) || 0)));
  private readonly back = safeReturn(this.q.get('return'));
  protected view() { return stepUpView({ kind: this.q.get('kind') ?? 'app', app: (this.q.get('app') ?? '').slice(0, 60), required: this.required(), current: Math.max(0, Number(this.q.get('current')) || 0), chains: this.chains() }); }
  constructor() { void this.load(); }
  private async load() {
    try { this.chains.set((await this.s.api.raw<{ chains: StepUpChain[] }>('GET', `/auth/me/step-up?level=${this.required()}`)).data.chains ?? []); }
    catch (e) { this.error.set((e as Error).message); }
    this.loading.set(false);
  }
  protected async go(c: StepUpChain) {
    this.busy.set(true);
    try {
      sessionStorage.setItem(RETURN_KEY, this.back);
      sessionStorage.setItem(STEP_UP_SUBJECT_KEY, (await this.s.loadAccess().catch(() => null))?.subject ?? '');
    } catch { /* storage blocked: the launchpad is the landing page after sign-in */ }
    await this.s.api.startBrowserLogin(sessionStorage, (u) => location.assign(u), c.id);
  }
  protected cancel() { void this.router.navigateByUrl('/my-applications'); }
  protected profile() { void this.router.navigateByUrl('/my-profile'); }
}
