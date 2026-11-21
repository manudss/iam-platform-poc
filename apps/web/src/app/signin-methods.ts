import { Component, input, output } from '@angular/core';
import { SigninChain } from './api';

/**
 * The sign-in method rows, shared by the sign-in page and the re-sign-in (step-up) page:
 * the exact same display everywhere - icon, name, steps line, declared-level gauge - only the list differs.
 */
@Component({
  selector: 'app-signin-methods',
  template: `
  <ul id="signin-methods" class="methods">
    @for (c of chains(); track c.id) {
      <li>
        <button type="button" class="m" [class.rec]="c.recommended || c.id === highlight()" [class.pv]="c.id === highlight()" [attr.data-chain]="c.id" [disabled]="busy()" (click)="pick.emit(c.id)">
          <span class="ic" aria-hidden="true">
            @switch (icon(c)) {
              @case ('shield') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3.5v5c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11v-5L12 2z"/><path d="M9 12l2 2 4-4.5"/></svg> }
              @case ('mail') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 7l10 6L22 7"/></svg> }
              @case ('pin') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> }
              @default { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.8 12.2L21 2m-4 2l3 3"/></svg> }
            }
          </span>
          <span class="tx">
            <b>{{ c.name }}@if (c.recommended) { <span class="tag">recommended</span> }</b>
            <span class="sub">{{ stepNames(c) }} · declared level {{ c.effectiveLevel }} of 10@if (c.simulated) { · <b class="sim">includes a simulated step (no real e-mail is sent)</b> }</span>
            <span class="dots" aria-hidden="true">@for (i of [0,1,2,3,4,5,6,7,8,9]; track i) { <i [class.on]="i < c.effectiveLevel"></i> }</span>
          </span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </li>
    }
  </ul>`,
  /* Moved verbatim from login.css: one card row per chain, name + recommended tag, steps line and the level gauge. */
  styles: [`
    .methods { list-style: none; margin: .8rem 0 0; padding: 0; display: grid; gap: .6rem; }
    .methods li { display: block; }
    .m { display: flex; align-items: center; gap: .8rem; width: 100%; margin: 0; text-align: left; background: var(--auth-field); border: 1px solid var(--line); border-radius: .8rem; padding: .7rem .85rem; color: var(--ink); transition: border-color .15s; }
    .m:hover:not(:disabled) { background: var(--auth-field); border-color: var(--accent); }
    .m.rec { border: 1.5px solid var(--acc2); }
    .m .ic { flex: none; width: 2.3rem; height: 2.3rem; border-radius: .65rem; display: grid; place-items: center; background: var(--chip-bg); color: var(--chip-ink); }
    .m .ic svg { width: 1.1rem; height: 1.1rem; }
    .m .tx { flex: 1; min-width: 0; }
    .m .tx b { display: block; font-size: .92rem; }
    .m .tx .sub { display: block; color: var(--muted); font-size: .78rem; }
    .m .chev { flex: none; width: 1rem; height: 1rem; color: var(--muted); }
    .m .tx .tag { display: inline-block; vertical-align: middle; font-size: .62rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; background: var(--accent); color: var(--accent-ink); border-radius: 999px; padding: .12rem .45rem; margin-left: .3rem; white-space: nowrap; }
    .dots { display: flex; gap: 2.5px; margin-top: .35rem; }
    .dots i { width: 14px; height: 5px; border-radius: 3px; background: var(--bar-off); }
    .dots i.on { background: var(--acc2); }
    .sim { color: var(--warn-ink); }
    .m.pv { outline: 3px solid var(--acc2); outline-offset: 2px; }
  `],
})
export class SigninMethods {
  readonly chains = input.required<SigninChain[]>();
  readonly busy = input(false);
  /** Chain to highlight in the admin preview frame; empty outside a preview. */
  readonly highlight = input('');
  readonly pick = output<string>();

  protected stepNames(c: SigninChain) { return c.steps.map((x) => x.name).join(' → '); }

  /** Leading icon of a chain from its step types: authenticator app, e-mail code, PIN keypad, else a plain password key. */
  protected icon(c: SigninChain): 'shield' | 'mail' | 'pin' | 'key' {
    const t = c.steps.map((x) => x.type);
    if (t.some((x) => /totp|authenticator/i.test(x))) return 'shield';
    if (t.some((x) => /mail/i.test(x))) return 'mail';
    if (t.some((x) => /pin/i.test(x))) return 'pin';
    return 'key';
  }
}
