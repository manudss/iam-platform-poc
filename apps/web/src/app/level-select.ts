import { Component, ElementRef, HostListener, inject, input, output, signal } from '@angular/core';

export const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/** The 10-bar level gauge of the public sign-in page (bars up to the level are lit). Decorative: the number always sits next to it. */
@Component({
  selector: 'app-level-gauge',
  template: `<span class="dots" aria-hidden="true">@for (i of bars; track i) { <i [class.on]="i < level()"></i> }</span>`,
  styles: [`.dots { display: inline-flex; gap: 2.5px; vertical-align: middle } .dots i { width: 14px; height: 5px; border-radius: 3px; background: var(--bar-off, #dcdef0) } .dots i.on { background: var(--accent, #4338ca) }`],
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
          (click)="toggle()" (keydown)="key($event)">
    <b>{{ value() }}</b><span class="of">of 10</span><app-level-gauge [level]="value()" /><span class="car" aria-hidden="true">▾</span>
  </button>
  @if (open()) {
    <ul class="ls-list" role="listbox" [attr.aria-label]="label()" tabindex="-1">
      @for (n of levels; track n) {
        <li role="option" [attr.aria-selected]="n === value()" [class.sel]="n === value()" [class.act]="n === active()" [attr.data-level]="n" (click)="pick(n)" (mouseenter)="active.set(n)">
          <b>{{ n }}</b><app-level-gauge [level]="n" />
        </li>
      }
    </ul>
  }`,
  styleUrl: './level-select.css',
})
export class LevelSelect {
  readonly value = input.required<number>();
  readonly label = input('Level');
  readonly id = input('');
  readonly disabled = input(false);
  readonly valueChange = output<number>();
  protected readonly levels = LEVELS;
  protected readonly open = signal(false);
  protected readonly active = signal(1);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected toggle() { if (this.open()) this.open.set(false); else { this.active.set(this.value()); this.open.set(true); } }
  protected pick(n: number) { this.valueChange.emit(n); this.open.set(false); }
  protected key(e: KeyboardEvent) {
    const k = e.key;
    if (!this.open()) { if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); this.toggle(); } return; }
    if (k === 'Escape') { e.preventDefault(); this.open.set(false); }
    else if (k === 'ArrowDown') { e.preventDefault(); this.active.set(Math.min(10, this.active() + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); this.active.set(Math.max(1, this.active() - 1)); }
    else if (k === 'Home') { e.preventDefault(); this.active.set(1); }
    else if (k === 'End') { e.preventDefault(); this.active.set(10); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); this.pick(this.active()); }
  }
  @HostListener('document:click', ['$event']) outside(e: Event) { if (this.open() && !this.host.nativeElement.contains(e.target as Node)) this.open.set(false); }
}
