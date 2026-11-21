import { Component, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

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
          [attr.aria-describedby]="tipOn() ? tipId : null" (click)="toggle()" (keydown)="key($event)" (mouseenter)="hoverBtn.set(true)" (mouseleave)="hoverBtn.set(false)" (focus)="focusBtn.set(true)" (blur)="focusBtn.set(false)">
    @if (value() === 0 && allowNone()) { <b class="none">No minimum</b> } @else { <b>{{ value() }}</b><span class="of">of 10</span><app-level-gauge [level]="value()" /> }<span class="car" aria-hidden="true">▾</span>
  </button>
  @if (open()) {
    <ul class="ls-list" role="listbox" [attr.aria-label]="label()" [attr.aria-activedescendant]="optId(active())" tabindex="-1">
      @if (allowNone()) {
        <li role="option" class="none" [attr.id]="optId(0)" [attr.aria-selected]="value() === 0" [class.sel]="value() === 0" [class.act]="active() === 0" data-level="0" (click)="tap(0, $event)" (touchstart)="touchStart()" (mouseenter)="active.set(0)"><b>No minimum</b></li>
      }
      @for (n of levels; track n) {
        <li role="option" [attr.id]="optId(n)" [attr.aria-selected]="n === value()" [attr.aria-disabled]="blocked(n) ? true : null" [class.sel]="n === value()" [class.act]="n === active()" [class.off]="blocked(n)" [attr.data-level]="n" (click)="tap(n, $event)" (touchstart)="touchStart()" (mouseenter)="active.set(n)">
          <b>{{ n }}</b><app-level-gauge [level]="n" />@if (blocked(n)) { <small class="nm">no method</small> }
        </li>
      }
    </ul>
  }
  @if (tipOn()) {
    <div class="ls-tip" role="tooltip" [id]="tipId" [attr.data-for]="tipLevel()">
      <strong>{{ tipLevel() === 0 ? 'No minimum' : 'Level ' + tipLevel() + ' of 10 or above' }}</strong>@if (tipLevel() > 0) { <app-level-gauge [level]="tipLevel()" /> }
      @if (tipLevel() === 0) { <p>The rule is off.</p> }
      @else if (!hasChains()) { <p>No information about the sign-in chains here.</p> }
      @else {
        <ul>
          @for (c of tipChains(); track c.id) {
            <li class="tc" [class.dim]="!c.usable || c.level < tipLevel()">
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
  readonly valueChange = output<number>();
  protected readonly tipId = `ls-tip-${++uid}`;
  protected readonly hoverBtn = signal(false); protected readonly focusBtn = signal(false);
  private touched = false;
  protected optId(n: number) { return `${this.tipId}-o${n}`; }
  protected hasChains() { return this.chains().length > 0; }
  protected blocked(n: number) { return this.restrict() && this.hasChains() && n !== this.value() && !reachableLevel(this.chains(), n); }
  protected tipLevel() { return this.open() ? this.active() : this.value(); }
  protected tipOn() { return this.open() || this.hoverBtn() || this.focusBtn(); }
  protected tipChains() { const n = this.tipLevel(); return [...this.chains()].sort((a, b) => Number(b.level >= n && b.usable) - Number(a.level >= n && a.usable) || b.level - a.level); }
  protected tipReach() { return reachableLevel(this.chains(), this.tipLevel()); }
  /** A saved level that no chain reaches anymore stays selected and visible with a warning; it is never changed silently. */
  protected warning() { return this.restrict() && this.hasChains() && this.value() > 0 && !reachableLevel(this.chains(), this.value()) ? `Level ${this.value()} is saved but no enabled sign-in chain reaches it. Apply will refuse it until you lower it or enable a chain.` : ''; }
  /** First touch on another option shows its tooltip, a second touch picks it; mouse and keyboard pick at once. */
  protected tap(n: number, e: Event) {
    if (this.blocked(n)) return;
    const touch = (e as PointerEvent).pointerType === 'touch' || this.touched;
    if (touch && this.active() !== n) { this.active.set(n); this.touched = false; return; }
    this.pick(n);
  }
  protected touchStart() { this.touched = true; }
  protected readonly levels = LEVELS;
  protected readonly open = signal(false);
  protected readonly active = signal(1);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected toggle() { if (this.open()) this.open.set(false); else { this.active.set(this.value()); this.open.set(true); } }
  protected pick(n: number) { if (this.blocked(n)) return; this.touched = false; this.valueChange.emit(n); this.open.set(false); }
  protected key(e: KeyboardEvent) {
    const k = e.key;
    if (!this.open()) { if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); this.toggle(); } return; }
    if (k === 'Escape') { e.preventDefault(); this.open.set(false); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.active.set(Math.min(10, this.active() + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.active.set(Math.max(this.allowNone() ? 0 : 1, this.active() - 1)); }
    else if (k === 'Home') { e.preventDefault(); this.active.set(this.allowNone() ? 0 : 1); }
    else if (k === 'End') { e.preventDefault(); this.active.set(10); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); this.pick(this.active()); }
  }
  @HostListener('document:click', ['$event']) outside(e: Event) { if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false); }
}
