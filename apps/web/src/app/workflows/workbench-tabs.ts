import { Component, Injectable, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

/** One open object in the workflows workbench: a workflow being edited or a run being watched. */
export interface WbTab { kind: 'workflow' | 'run'; id: string; label: string }

const KEY = 'wf-workbench-tabs';
const MAX_TABS = 12;

const loadTabs = (): WbTab[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as WbTab[];
    return Array.isArray(raw) ? raw.filter((t) => t && (t.kind === 'workflow' || t.kind === 'run') && typeof t.id === 'string' && typeof t.label === 'string') : [];
  } catch { return []; }
};

/** The workbench's open-object tabs (design direction C). Persisted in localStorage so the bar survives
 * navigation and reloads; pages register themselves as they open. */
@Injectable({ providedIn: 'root' })
export class WbTabs {
  private readonly router = inject(Router);
  readonly tabs = signal<WbTab[]>(loadTabs());

  static keyOf(t: WbTab) { return `${t.kind}:${t.id}`; }
  urlOf(t: WbTab): string { return t.kind === 'run' ? `/workflows/run/${t.id}` : `/workflows/edit/${t.id}`; }
  isActive(t: WbTab): boolean { return this.router.url.split('?')[0] === this.urlOf(t); }

  /** Registers (or moves to the front, on re-open) the tab of an object being viewed. */
  open(kind: WbTab['kind'], id: string, label: string) {
    const key = `${kind}:${id}`;
    const rest = this.tabs().filter((t) => WbTabs.keyOf(t) !== key);
    const existing = this.tabs().find((t) => WbTabs.keyOf(t) === key);
    this.set([...rest, { kind, id, label: existing && existing.label === label ? existing.label : label }].slice(-MAX_TABS));
  }

  /** Renames a tab (workflow renamed in the editor). */
  rename(kind: WbTab['kind'], id: string, label: string) {
    this.set(this.tabs().map((t) => (WbTabs.keyOf(t) === `${kind}:${id}` ? { ...t, label } : t)));
  }

  /** Replaces one tab by another (the "new workflow" tab becomes the saved workflow's tab). */
  replace(from: WbTab, to: WbTab) {
    const gone = this.tabs().filter((t) => WbTabs.keyOf(t) !== WbTabs.keyOf(from) && WbTabs.keyOf(t) !== WbTabs.keyOf(to));
    this.set([...gone, to]);
  }

  /** Drops tabs whose objects no longer exist (the pages call this when a load 404s). */
  drop(kind: WbTab['kind'], id: string) { this.set(this.tabs().filter((t) => WbTabs.keyOf(t) !== `${kind}:${id}`)); }

  close(t: WbTab, ev?: Event) {
    ev?.preventDefault(); ev?.stopPropagation();
    const wasActive = this.isActive(t);
    const rest = this.tabs().filter((x) => WbTabs.keyOf(x) !== WbTabs.keyOf(t));
    this.set(rest);
    if (wasActive) void this.router.navigateByUrl(rest.length ? this.urlOf(rest[rest.length - 1]) : '/workflows');
  }

  private set(tabs: WbTab[]) {
    this.tabs.set(tabs);
    try { localStorage.setItem(KEY, JSON.stringify(tabs)); } catch { /* private mode: tabs live for the session only */ }
  }
}

@Component({ selector: 'app-wb-tabs', imports: [RouterLink], styles: [`
.wbt-bar { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--line); margin-bottom: .6rem; }
.wbt-tab { display: inline-flex; align-items: center; gap: .35rem; padding: .35rem .6rem; font-size: .85rem; color: var(--muted); text-decoration: none; border: 1px solid var(--line); border-bottom: 0; border-radius: .45rem .45rem 0 0; white-space: nowrap; max-width: 260px; cursor: pointer; }
.wbt-tab.current, .wbt-tab:hover { color: var(--ink); }
.wbt-tab.current { background: var(--card); font-weight: 600; }
.wbt-label { overflow: hidden; text-overflow: ellipsis; }
.wbt-x { background: none; border: 0; color: var(--muted); padding: 0 .1rem; min-height: 0; font-size: .9rem; line-height: 1; cursor: pointer; }
.wbt-x:hover { color: var(--bad); }
`], template: `
<div class="wbt-bar" role="tablist">
  @for (t of tabs.tabs(); track t.kind + ':' + t.id) {
    <a class="wbt-tab" role="tab" [class.current]="tabs.isActive(t)" [routerLink]="tabs.urlOf(t)">
      <span class="wbt-ico" aria-hidden="true">{{t.kind === 'run' ? '▶' : '✎'}}</span><span class="wbt-label">{{t.label}}</span><button class="wbt-x" (click)="tabs.close(t, $event)" [attr.aria-label]="'Close ' + t.label" title="Close">×</button>
    </a>
  }
  <a class="wbt-tab wbt-add" routerLink="/workflows" title="Open a workflow from the list">+</a>
</div>
` })
export class WbTabsBar {
  protected readonly tabs = inject(WbTabs);
}
