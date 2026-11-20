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
    <span class="sesswrap" [class.open]="open()">
      <button type="button" class="sess" [class.warn]="s.warning()" id="session-timer" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-controls="session-panel" (click)="open.set(!open())" [attr.aria-label]="'Session time left ' + label()">
        <span class="lbl" id="session-left">{{label()}}</span>
        <span class="track" role="progressbar" aria-label="Time left in your session" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pct()"><span class="fill" id="session-fill" [style.width.%]="pct()"></span></span>
      </button>
      <div class="spanel" id="session-panel" role="dialog" aria-label="Session">
        <p class="stip">{{tip()}}</p>
        <p class="smeta">Time left <b>{{label()}}</b>@if (maxLabel()) { · at most {{maxLabel()}} more in this session }</p>
        @if (problem()) { <p class="bad" role="alert">{{problem()}}</p> }
        <div class="sact">
          <button type="button" id="session-extend-panel" (click)="stay()" [disabled]="!s.canExtend() || s.extending()" [attr.title]="s.canExtend() ? null : 'The maximum session length is reached.'">{{ s.extending() ? 'Renewing…' : 'Extend session' }}</button>
          <button type="button" class="secondary" id="session-signout-panel" (click)="s.expire()">Sign out</button>
        </div>
        @if (!s.canExtend()) { <p class="smeta">Extending is unavailable: the maximum session length is reached.</p> }
      </div>
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
    .sesswrap { position: relative; display: inline-flex; }
    .sess { display: inline-flex; flex-direction: column; justify-content: center; gap: 4px; box-sizing: border-box; height: var(--ctl-h, 2.5rem); width: 7.5rem; margin: 0; padding: 0 .75rem; border: 1px solid transparent; border-radius: 999px; background: transparent; font: inherit; font-size: .72rem; color: var(--th-ink); cursor: pointer; }
    .sesswrap:hover .sess, .sesswrap.open .sess, .sess:focus-visible { border-color: var(--line); background: var(--row-hover); }
    .lbl { font-variant-numeric: tabular-nums; line-height: 1; text-align: left; }
    .track { display: block; height: 5px; border-radius: 3px; background: var(--bar-off); overflow: hidden; }
    .fill { display: block; height: 100%; background: var(--acc2); transition: width 1s linear; }
    .warn .fill { background: var(--warn-ink); } .warn { color: var(--warn-ink); font-weight: 600; }
    .spanel { display: none; position: absolute; top: calc(100% + .45rem); left: 0; z-index: 30; width: min(18rem, calc(100vw - 1rem)); box-sizing: border-box; padding: .8rem .9rem; background: var(--card); color: var(--ink); border: 1px solid var(--line); border-radius: .6rem; box-shadow: 0 12px 30px var(--shadow-color); font-size: .82rem; }
    .spanel::before { content: ''; position: absolute; left: 0; right: 0; top: -.5rem; height: .5rem; }
    .sesswrap:hover .spanel, .sesswrap:focus-within .spanel, .sesswrap.open .spanel { display: block; }
    .spanel p { margin: 0 0 .6rem; } .spanel .smeta { color: var(--muted); }
    .sact { display: flex; gap: .5rem; } .sact button { flex: 1; min-height: 2.5rem; margin: 0; }
    .veil { position: fixed; inset: 0; background: var(--scrim); display: grid; place-items: center; z-index: 50; }
    .dlg { background: var(--card); color: var(--ink); border-radius: .7rem; padding: 1.2rem 1.4rem; width: min(26rem, calc(100vw - 2rem)); box-shadow: 0 20px 50px var(--shadow-color); }
    .dlg h3 { margin: 0 0 .5rem; } .dlg p { margin: 0 0 .8rem; } .bad { color: var(--bad); }
    .act { display: flex; gap: .6rem; flex-wrap: wrap; }
    @media (max-width: 900px) { .sess { height: var(--ctl-h, 2.75rem); } }
    @media (max-width: 600px) { .sess { width: 4.6rem; padding: 0 .5rem; } .lbl { font-size: .65rem; } .spanel { left: auto; right: -2rem; } }
  `],
})
export class SessionTimer {
  protected readonly s = inject(Session);
  protected readonly open = signal(false);
  protected readonly problem = signal('');
  protected readonly maxLabel = computed(() => { const l = this.s.timing()?.limit; return l ? clock(Math.max(0, l - this.s.now())) : ''; });
  protected readonly label = computed(() => clock(this.s.remainingMs()));
  protected readonly pct = computed(() => Math.round(this.s.remainingShare() * 100));
  protected readonly tip = computed(() => `Time left before you are signed out. The bar empties as the time runs out. ${this.s.canExtend() ? 'You get a warning shortly before the end and can stay signed in.' : 'This session cannot be extended any more.'}`);
  protected async stay() { this.problem.set(await this.s.extend()); }
}
