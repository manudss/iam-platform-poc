import { Component, DestroyRef, ElementRef, HostListener, effect, inject, input, output, signal, viewChild } from '@angular/core';

export const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** One sign-in chain as the tooltip shows it. `level` is the level the chain proves; `usable` is false for a disabled chain or one with a simulated step. */
export interface LevelChain { id: string; name: string; level: number; declared?: number; steps: string[]; usable: boolean; why?: string }
/** Same rule as the server (AuthnService.reachable): an enabled chain with no simulated step whose level is at least n. */
export const reachableLevel = (chains: readonly LevelChain[], n: number) => n <= 0 || chains.some((c) => c.usable && c.level >= n);
/** Builds the chains from GET /auth (working.config + working.analyses). Never invents a level: the effective level of the analysis wins. */
export const levelChains = (cfg: { methods: { id: string; name: string; enabled: boolean }[]; chains: { id: string; name: string; enabled?: boolean; steps: string[]; level: number }[] }, analyses: { id: string; effectiveLevel: number; simulatedSteps: string[] }[]): LevelChain[] =>
  cfg.chains.map((c) => {
    const a = analyses.find((x) => x.id === c.id);
    const off = c.enabled === false || c.steps.some((id) => !cfg.methods.find((m) => m.id === id)?.enabled);
    const sim = (a?.simulatedSteps.length ?? 0) > 0;
    return { id: c.id, name: c.name, level: a?.effectiveLevel ?? c.level, declared: c.level, steps: c.steps.map((id) => cfg.methods.find((m) => m.id === id)?.name ?? id), usable: !off && !sim, ...(off ? { why: 'disabled' } : sim ? { why: 'simulated step' } : {}) };
  });
let uid = 0;

/** The 10-bar level gauge of the public sign-in page (bars up to the level are lit). Decorative: the number always sits next to it. */
@Component({
  selector: 'app-level-gauge',
  template: `<span class="dots" aria-hidden="true">@for (i of bars; track i) { <i [class.on]="i < level()"></i> }</span>`,
  styles: [`.dots { display: inline-flex; gap: 2.5px; vertical-align: middle } .dots i { width: 14px; height: 5px; border-radius: 3px; background: var(--bar-off) } .dots i.on { background: var(--chip-ink) }`],
})
export class LevelGauge { readonly level = input.required<number>(); protected readonly bars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]; }

/**
 * Level picker: a listbox where each option shows the number (1 to 10) and its gauge. Keyboard: arrows, Home, End, Enter or Space, Escape.
 * 10 = strongest. The level is declared by an administrator, never measured.
 */
@Component({
  selector: 'app-level-select',
  imports: [LevelGauge],
  template: `
  <button type="button" class="ls-btn" role="combobox" aria-haspopup="listbox" [attr.aria-expanded]="open()" [attr.aria-label]="label()" [id]="id()" [disabled]="disabled()"
          [attr.aria-describedby]="tipOn() ? tipId : null" (click)="toggle()" (keydown)="key($event)" (pointerdown)="ptr($event)" (mouseenter)="hoverIn()" (mouseleave)="hoverOut()" (focus)="focusIn($event)" (blur)="focusOut()">
    @if (value() === 0 && allowNone()) { <b class="none">No minimum</b> } @else { <b>{{ value() }}</b><span class="of">of 10</span><app-level-gauge [level]="value()" /> }<span class="car" aria-hidden="true">▾</span>
  </button>
  @if (open()) {
    <ul class="ls-list" role="listbox" (click)="$event.preventDefault()" [attr.aria-label]="label()" [attr.aria-activedescendant]="optId(active())" tabindex="-1">
      @if (allowNone()) {
        <li role="option" class="none" [attr.id]="optId(0)" [attr.aria-selected]="value() === 0" [class.sel]="value() === 0" [class.act]="active() === 0" data-level="0" (pointerdown)="optDown(0, $event)" (pointercancel)="optCancel()" (click)="tap(0)" (mouseenter)="active.set(0)"><b>No minimum</b></li>
      }
      @for (n of levels; track n) {
        <li role="option" [attr.id]="optId(n)" [attr.aria-selected]="n === value()" [attr.aria-disabled]="blocked(n) ? true : null" [class.sel]="n === value()" [class.act]="n === active()" [class.off]="blocked(n)" [attr.data-level]="n" (pointerdown)="optDown(n, $event)" (pointercancel)="optCancel()" (click)="tap(n)" (mouseenter)="active.set(n)">
          <b>{{ n }}</b><app-level-gauge [level]="n" />@if (blocked(n)) { <small class="nm">no method</small> }
        </li>
      }
    </ul>
  }
  @if (tipOn()) {
    <div #tip class="ls-tip" role="tooltip" [id]="tipId" [attr.data-for]="tipLevel()">
      <strong>{{ tipLevel() === 0 ? 'No minimum' : 'Level ' + tipLevel() + ' of 10 or above' }}</strong>@if (tipLevel() > 0) { <app-level-gauge [level]="tipLevel()" /> }
      @if (tipLevel() === 0) { <p>The rule is off.</p> }
      @else if (chainsError()) { <p class="warn">The sign-in chains could not be loaded, so reachable levels are not shown. Apply still refuses a level no chain can reach.</p> }
      @else if (!hasChains()) { <p>No sign-in chain is defined.</p> }
      @else {
        <ul>
          @for (c of tipChains(); track c.id) {
            <li class="tc" [class.dim]="!c.usable || c.level < tipLevel()" [attr.data-state]="c.usable && c.level >= tipLevel() ? 'ok' : 'dim'">
              <span class="tx"><b>{{ c.name }}@if (c.steps.length > 1) { <span class="tag g">chain</span> }</b>
                <span class="sub">{{ c.steps.join(' + ') }} &middot; declared level {{ c.declared ?? c.level }} of 10@if ((c.declared ?? c.level) !== c.level) { &middot; proves {{ c.level }} }@if (c.why) { &middot; <b class="sim">{{ c.why }}</b> }</span>
                <app-level-gauge [level]="c.level" /></span>
            </li>
          }
        </ul>
        @if (!tipReach()) { <p class="warn">No enabled chain without a simulated step reaches this level.</p> }
        @if (!restrict()) { <p class="hint">Informational: this editor declares levels, none is blocked.</p> }
      }
    </div>
  }
  @if (warning()) { <p class="ls-warn" role="alert">{{ warning() }}</p> }`,
  styleUrl: './level-select.css',
})
export class LevelSelect {
  readonly value = input.required<number>();
  readonly label = input('Level');
  readonly id = input('');
  readonly disabled = input(false);
  /** Adds a first entry, "No minimum" (value 0), for settings where 0 means off. */
  readonly allowNone = input(false);
  /** The sign-in chains, for the tooltip and for disabling levels no chain reaches. Empty = no information (nothing disabled). */
  readonly chains = input<readonly LevelChain[]>([]);
  /** True for a consumer of a requirement (administration level, level per application): unreachable levels cannot be picked. False for an editor that DECLARES levels (auth methods): informational only. */
  readonly restrict = input(false);
  /** True when the chains could not be read (error or refusal): different from "no chain". Nothing is disabled on the screen, Apply on the server still refuses an unreachable level. */
  readonly chainsError = input(false);
  readonly valueChange = output<number>();
  protected readonly tipId = `ls-tip-${++uid}`;
  protected readonly hoverBtn = signal(false); protected readonly focusBtn = signal(false);
  protected readonly dismissed = signal(false);
  private readonly tipRef = viewChild<ElementRef<HTMLElement>>('tip');
  /** What kind of pointer last touched the control, and whether the option was already the active one at pointer down (before any emulated mouse event). */
  private pointer = ''; private wasActive = false; private cancelled = false;
  protected readonly levels = LEVELS;
  protected readonly open = signal(false);
  protected readonly active = signal(1);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  constructor() {
    const destroy = inject(DestroyRef);
    // The tooltip is shown in an overlay on the page (fixed, outside any drawer or scrolling parent that could clip or move it) and placed against the viewport.
    effect(() => {
      const el = this.tipRef()?.nativeElement; this.tipLevel(); this.open(); this.chains();
      if (!el || typeof document === 'undefined') return;
      if (el.parentElement !== document.body) document.body.appendChild(el);
      queueMicrotask(() => this.place(el));
    });
    destroy.onDestroy(() => this.tipRef()?.nativeElement.remove());
  }
  private place(el: HTMLElement) {
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    el.style.maxHeight = `${vh - 2 * m}px`;
    if (vw <= 600) {
      // Bottom sheet capped at 40% of the viewport, on the side opposite the option being touched so it never covers the list.
      el.style.maxHeight = `${Math.min(vh - 2 * m, Math.round(vh * 0.4))}px`;
      const opt0 = this.open() ? this.host.nativeElement.querySelector(`li[data-level="${this.active()}"]`) as HTMLElement | null : null;
      const r0 = (opt0 ?? this.host.nativeElement.querySelector('button') as HTMLElement).getBoundingClientRect();
      const top = (r0.top + r0.bottom) / 2 > vh / 2;
      Object.assign(el.style, { left: `${m}px`, right: `${m}px`, width: 'auto', top: top ? `${m}px` : 'auto', bottom: top ? 'auto' : `${m}px` });
      return;
    }
    const w = Math.min(272, vw - 2 * m); el.style.width = `${w}px`; el.style.right = 'auto'; el.style.bottom = 'auto';
    const h = el.getBoundingClientRect().height;
    const list = this.host.nativeElement.querySelector('.ls-list') as HTMLElement | null;
    const opt = this.host.nativeElement.querySelector(`li[data-level="${this.active()}"]`) as HTMLElement | null;
    const a = (list ?? (this.host.nativeElement.querySelector('button') as HTMLElement)).getBoundingClientRect();
    const o = this.open() && opt ? opt.getBoundingClientRect() : a;
    let x: number, y = o.top;
    if (a.right + m + w <= vw - m) x = a.right + m;            // beside the list, on the right
    else if (a.left - m - w >= m) x = a.left - m - w;          // no room: on the left
    else { x = a.left; y = a.bottom + m + h <= vh - m ? a.bottom + m : a.top - m - h; }   // else below, or above
    x = Math.max(m, Math.min(x, vw - w - m)); y = Math.max(m, Math.min(y, vh - h - m));
    el.style.left = `${x}px`; el.style.top = `${y}px`;
  }
  protected optId(n: number) { return `${this.tipId}-o${n}`; }
  protected hasChains() { return this.chains().length > 0; }
  protected blocked(n: number) { return this.restrict() && this.hasChains() && n !== this.value() && !reachableLevel(this.chains(), n); }
  protected tipLevel() { return this.open() ? this.active() : this.value(); }
  protected tipOn() { return !this.dismissed() && (this.open() || this.hoverBtn() || this.focusBtn()); }
  protected tipChains() { const n = this.tipLevel(); return [...this.chains()].sort((a, b) => Number(b.level >= n && b.usable) - Number(a.level >= n && a.usable) || b.level - a.level); }
  protected tipReach() { return reachableLevel(this.chains(), this.tipLevel()); }
  /** A saved level that no chain reaches anymore stays selected and visible with a warning; it is never changed silently. */
  protected warning() { return this.restrict() && this.hasChains() && this.value() > 0 && !reachableLevel(this.chains(), this.value()) ? `Level ${this.value()} is saved but no enabled sign-in chain reaches it. Apply will refuse it until you lower it or enable a chain.` : ''; }
  protected ptr(e: PointerEvent) { this.pointer = e.pointerType; }
  protected hoverIn() { if (this.pointer === 'touch') return; this.dismissed.set(false); this.hoverBtn.set(true); }
  protected hoverOut() { this.hoverBtn.set(false); this.dismissed.set(false); }
  /** Keyboard focus only (a tap leaves focus on the button and must not keep a tooltip over the page). */
  protected focusIn(e: FocusEvent) { let kb = true; try { kb = (e.target as HTMLElement).matches(':focus-visible'); } catch { /* old engine: keep it */ } if (kb) { this.dismissed.set(false); this.focusBtn.set(true); } }
  protected focusOut() { this.focusBtn.set(false); this.dismissed.set(false); }
  protected optDown(n: number, e: PointerEvent) { this.pointer = e.pointerType; this.wasActive = this.active() === n; this.cancelled = false; }
  protected optCancel() { this.pointer = ''; this.wasActive = false; this.cancelled = true; }
  /** Touch: the first tap on an option only shows its tooltip (it becomes active), a tap on the already active option picks it. Mouse, pen and keyboard pick at once. A cancelled gesture (scroll) never picks. */
  protected tap(n: number) {
    if (this.cancelled) { this.cancelled = false; return; }
    if (this.blocked(n)) return;
    const touch = this.pointer === 'touch'; const was = this.wasActive; this.pointer = ''; this.wasActive = false;
    if (touch && !was) { this.active.set(n); return; }
    this.pick(n);
  }
  protected toggle() { this.dismissed.set(false); if (this.open()) this.open.set(false); else { this.active.set(this.value()); this.open.set(true); } }
  protected pick(n: number) { if (this.blocked(n)) return; this.valueChange.emit(n); this.open.set(false); }
  protected key(e: KeyboardEvent) {
    const k = e.key;
    if (k === 'Escape' && this.tipOn()) { this.dismissed.set(true); if (!this.open()) return; }
    if (!this.open()) { if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); this.toggle(); } return; }
    if (k === 'Escape') { e.preventDefault(); this.open.set(false); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.active.set(Math.min(10, this.active() + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.active.set(Math.max(this.allowNone() ? 0 : 1, this.active() - 1)); }
    else if (k === 'Home') { e.preventDefault(); this.active.set(this.allowNone() ? 0 : 1); }
    else if (k === 'End') { e.preventDefault(); this.active.set(10); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); this.pick(this.active()); }
  }
  @HostListener('document:keydown.escape') esc() { if (this.tipOn()) this.dismissed.set(true); }
  @HostListener('document:click', ['$event']) outside(e: Event) { if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false); }
}
