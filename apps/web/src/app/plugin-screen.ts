import { Component, ElementRef, Injectable, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Session } from './session';

interface ScreenInv { plugin: string; id: string; title: string; area: string; render: string; schemaRef?: string; component?: string }

/** The one seam the browser tests replace: fetch the packaged screen module. In production this is a plain
 * dynamic import() of the asset the API serves from the plugin's signed folder. */
@Injectable({ providedIn: 'root' })
export class PluginScreenLoader {
  load(url: string): Promise<{ default?: string }> { return import(/* webpackIgnore: true */ url) as Promise<{ default?: string }>; }
}

/**
 * A plugin screen rendered by the plugin's own packaged code (constat 4): the console keeps no page for it.
 * The module (an .mjs asset in the plugin's signed folder, served by GET /plugins/:id/assets/) registers a
 * custom element and default-exports its tag; the host creates the element and hands it the session context.
 * The route exists for every screen of the tenant's inventory, so a plugin adds its screen without touching
 * apps/web, and disabling the plugin removes it from the inventory - the host then says it is gone.
 */
@Component({
  selector: 'app-plugin-screen', styleUrl: './pages.css',
  template: `
  @if (problem()) { <p role="alert" class="msg bad" id="plugin-screen-problem">{{problem()}}</p> }
  <div #mount id="plugin-screen-mount"></div>`,
})
export class PluginScreenPage {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly loader = inject(PluginScreenLoader);
  private readonly mount = viewChild<ElementRef<HTMLElement>>('mount');
  protected readonly problem = signal('');
  private readonly params = signal({ plugin: '', screen: '' });
  private request = 0;

  constructor() {
    this.route.paramMap.subscribe((pm) => this.params.set({ plugin: pm.get('plugin') ?? '', screen: pm.get('screen') ?? '' }));
    effect(() => {
      this.s.branchEpoch(); this.s.adminToken(); // a branch or session change rebuilds the screen with a fresh context
      const m = this.mount(); // the query settling re-triggers the effect once the view exists
      if (!m) return;
      const { plugin, screen } = this.params();
      if (plugin && screen) void this.show(plugin, screen, ++this.request);
    });
  }

  private async show(plugin: string, screen: string, req: number) {
    const mount = this.mount()!.nativeElement;
    mount.replaceChildren(); this.problem.set('');
    let inv: ScreenInv[];
    try { inv = (await this.s.api.raw<{ screens: ScreenInv[] }>('GET', '/plugins/screens', undefined, this.headers())).data.screens ?? []; }
    catch { return; } // the shell already surfaces API problems; a missing inventory leaves an empty screen
    const sc = inv.find((x) => x.plugin === plugin && x.id === screen);
    if (req !== this.request) return;
    if (!sc) { this.problem.set('This screen is not available: the plugin is not enabled on this branch (or grants changed).'); return; }
    if (sc.render !== 'component' || !sc.component) { this.problem.set(`Screen ${plugin}/${screen} is console-native; it has no packaged module yet.`); return; }
    try {
      const mod = await this.loader.load(`/api/tenants/${encodeURIComponent(this.s.api.tenant)}/plugins/${encodeURIComponent(plugin)}/assets/${sc.component.split('/').map(encodeURIComponent).join('/')}`);
      const tag = mod?.default;
      if (req !== this.request) return;
      if (typeof tag !== 'string' || !tag) throw new Error('the screen module must default-export its custom-element tag');
      const el = document.createElement(tag) as HTMLElement & { context?: unknown };
      el.context = this.context();
      mount.replaceChildren(el);
    } catch (e) { if (req === this.request) this.problem.set(`The plugin screen failed to load: ${(e as Error).message ?? e}`); }
  }

  private headers(): Record<string, string> { const t = this.s.adminToken(); return t ? { 'x-api-admin-token': t } : {}; }
  private context() {
    return { tenant: this.s.api.tenant, api: `/api/tenants/${this.s.api.tenant}`, token: this.s.api.bearerToken, adminToken: this.s.adminToken(), branch: this.s.branch() };
  }
}
