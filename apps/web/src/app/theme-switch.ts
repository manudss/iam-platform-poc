import { Component, inject } from '@angular/core';
import { Theme, ThemeMode } from './theme';

interface Mode { id: ThemeMode; label: string }

/** Segmented theme selector: Auto follows the browser/system setting, Light and Dark force a theme (remembered). */
@Component({
  selector: 'app-theme-switch',
  template: `
    <span class="seg" role="group" aria-label="Color theme">
      @for (m of modes; track m.id) {
        <button type="button" [class.on]="theme.mode() === m.id" [attr.aria-pressed]="theme.mode() === m.id" [attr.data-theme-mode]="m.id" (click)="theme.set(m.id)">
          @switch (m.id) {
            @case ('auto') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> }
            @case ('light') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg> }
            @case ('dark') { <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg> }
          }
          <span>{{ m.label }}</span>
        </button>
      }
    </span>
  `,
  styles: [`
    .seg { display: inline-flex; gap: .25rem; padding: .28rem; border-radius: 999px; background: var(--card-auth, var(--card)); border: 1px solid var(--line); box-shadow: var(--shadow); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
    button { display: inline-flex; align-items: center; gap: .35rem; margin: 0; padding: .32rem .7rem; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: .8rem; font-weight: 600; cursor: pointer; }
    button:hover:not(.on) { color: var(--ink); background: transparent; }
    button.on { background: var(--accent); color: var(--accent-ink); }
    button.on:hover { background: var(--accent); }
    button svg { width: .85rem; height: .85rem; }
    @media (max-width: 480px) { button span { display: none; } button { padding: .32rem .55rem; } }
  `],
})
export class ThemeSwitch {
  protected readonly theme = inject(Theme);
  protected readonly modes: Mode[] = [{ id: 'auto', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];
}
