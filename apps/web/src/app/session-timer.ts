import { Component, computed, inject, signal } from '@angular/core';
import { Session } from './session';

/** h:mm:ss from one hour, m:ss below. */
export function clock(ms: number): string {
  const t = Math.ceil(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60, p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/**
 * Session timer (docs/session.md): an inverted progress bar that empties as the session token runs out, and a dialog in the last moments
 * that offers to stay signed in. Self-contained: it reads only the Session service, so it can sit in any bar of the shell.
 * Staying signed in asks the core for a fresh token of the same sign-in; no password is asked again.
 */
@Component({
  selector: 'app-session-timer',
  template: `
  @if (s.timing() && s.loggedIn()) {
    <span class="sess" [class.warn]="s.warning()" id="session-timer" tabindex="0" [attr.title]="tip()" [attr.aria-label]="'Session time left ' + label()">
      <span class="lbl" id="session-left">{{label()}}</span>
      <span class="track" role="progressbar" aria-label="Time left in your session" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pct()"><span class="fill" id="session-fill" [style.width.%]="pct()"></span></span>
    </span>
  }
  @if (s.warning() && s.loggedIn()) {
    <div class="veil"><div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="sess-t" aria-describedby="sess-d" id="session-dialog">
      <h3 id="sess-t">Your session is about to end</h3>
      <p id="sess-d">You will be signed out in <b>{{label()}}</b>. @if (s.canExtend()) { Stay signed in to keep working: this renews your session without asking for your password again. } @else { The maximum session length is reached, so it cannot be extended. Save your work; you will need to sign in again. }</p>
      @if (problem()) { <p class="bad" role="alert">{{problem()}}</p> }
      <div class="act">
        @if (s.canExtend()) { <button type="button" id="session-extend" (click)="stay()" [disabled]="s.extending()">{{ s.extending() ? 'Renewing…' : 'Stay signed in' }}</button> }
        <button type="button" class="secondary" id="session-signout" (click)="s.expire()">Sign out now</button>
        @if (!s.canExtend()) { <button type="button" class="secondary" id="session-dismiss" (click)="s.dismissed.set(true)">Understood</button> }
      </div>
    </div></div>
  }`,
  styles: [`
    :host { display: inline-flex; align-items: center; }
    .sess { display: inline-flex; flex-direction: column; gap: 3px; width: 6.5rem; font-size: .72rem; color: #475569; cursor: help; }
    .lbl { font-variant-numeric: tabular-nums; line-height: 1; }
    .track { display: block; height: 5px; border-radius: 3px; background: #e2e8f0; overflow: hidden; }
    .fill { display: block; height: 100%; background: #4f46e5; transition: width 1s linear; }
    .warn .fill { background: #d97706; } .warn { color: #b45309; font-weight: 600; }
    .veil { position: fixed; inset: 0; background: #0f172a99; display: grid; place-items: center; z-index: 50; }
    .dlg { background: #fff; border-radius: .7rem; padding: 1.2rem 1.4rem; width: min(26rem, calc(100vw - 2rem)); box-shadow: 0 20px 50px #0f172a66; }
    .dlg h3 { margin: 0 0 .5rem; } .dlg p { margin: 0 0 .8rem; } .bad { color: #b91c1c; }
    .act { display: flex; gap: .6rem; flex-wrap: wrap; }
    @media (max-width: 600px) { :host { flex: 0 1 auto; min-width: 0; overflow: hidden; } .sess { width: 2.6rem; } .lbl { font-size: .65rem; } }
  `],
})
export class SessionTimer {
  protected readonly s = inject(Session);
  protected readonly problem = signal('');
  protected readonly label = computed(() => clock(this.s.remainingMs()));
  protected readonly pct = computed(() => Math.round(this.s.remainingShare() * 100));
  protected readonly tip = computed(() => `Time left before you are signed out. The bar empties as the time runs out. ${this.s.canExtend() ? 'You get a warning shortly before the end and can stay signed in.' : 'This session cannot be extended any more.'}`);
  protected async stay() { this.problem.set(await this.s.extend()); }
}
