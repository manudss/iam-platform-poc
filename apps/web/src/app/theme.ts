import { Injectable, computed, effect, signal } from '@angular/core';

export type ThemeMode = 'auto' | 'light' | 'dark';
const KEY = 'iam.theme';
// Same choice for the core sign-in pages (/authorize...), which live outside this SPA: the server reads it.
const COOKIE = 'iam_theme';

/**
 * Light/dark theme for the whole console. 'auto' follows the browser/system preference (prefers-color-scheme),
 * a manual choice is remembered in localStorage and mirrored to the 'iam_theme' cookie so the
 * core sign-in pages pick the same theme. The resolved theme only sets data-theme on <html>:
 * every color adapts through the CSS variables of styles.css. index.html applies the same rule before first paint.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  readonly mode = signal<ThemeMode>(Theme.load());
  readonly systemDark = signal(this.media?.matches ?? false);
  readonly resolved = computed<'light' | 'dark'>(() => { const m = this.mode(); return m === 'auto' ? (this.systemDark() ? 'dark' : 'light') : m; });

  constructor() {
    this.media?.addEventListener?.('change', (e) => this.systemDark.set(e.matches));
    effect(() => { document.documentElement.dataset['theme'] = this.resolved(); });
  }

  set(mode: ThemeMode) {
    this.mode.set(mode);
    try { localStorage.setItem(KEY, mode); } catch { /* storage blocked: the choice only lives for this tab */ }
    document.cookie = `${COOKIE}=${mode}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  private static load(): ThemeMode {
    try { const v = localStorage.getItem(KEY); if (v === 'auto' || v === 'light' || v === 'dark') return v; } catch { /* storage blocked */ }
    // first visit or cleared storage: the cookie (possibly set on a core sign-in page) wins
    const m = document.cookie.match(/(?:^|;\s*)iam_theme=(auto|light|dark)(?:;|$)/);
    return m ? (m[1] as ThemeMode) : 'auto';
  }
}
