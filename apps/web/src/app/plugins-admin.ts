import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { Session } from './session';
import { FormsModule } from '@angular/forms';
import { ApiClient, FormModel, PluginAdminClient, PluginInfo, formValues, visibleFields } from './api';

/**
 * Generic plugin administration. Nothing here is specific to one plugin: the list, the grant prompts and the settings form
 * are all built from what the API returns (the plugin manifests). A new plugin shows up here with no change to the console.
 */
@Component({
  selector: 'app-plugins-admin',
  imports: [FormsModule],
  templateUrl: './plugins-admin.html',
  styleUrl: './plugins-admin.css',
})
export class PluginsAdmin {
  @Input({ required: true }) api!: ApiClient;
  /** Plugin shown in the detail panel, driven by the route (/plugins/:id). */
  @Input() pluginId: string | null = null;
  @Output() opened = new EventEmitter<string | null>();
  protected readonly session = inject(Session);
  protected admin!: PluginAdminClient;
  protected readonly plugins = signal<PluginInfo[]>([]);
  protected readonly selected = signal<PluginInfo | null>(null);
  protected readonly model = signal<FormModel | null>(null);
  protected readonly note = signal('');
  protected edited: Record<string, unknown> = {};
  protected grantInstall = false;
  protected grantComponents = false;
  protected grantHooks: Record<string, boolean> = {};

  async ngOnInit() {
    this.admin = new PluginAdminClient(this.api); await this.refresh();
    const want = this.plugins().find((p) => p.id === this.pluginId); if (want) await this.open(want, false);
  }

  protected async refresh() {
    try { this.plugins.set(await this.admin.list()); } catch (e) { this.note.set((e as Error).message); }
  }
  protected async open(p: PluginInfo, announce = true) {
    if (announce) this.opened.emit(p.id);
    this.selected.set(p); this.note.set(''); this.grantInstall = false; this.grantComponents = false; this.grantHooks = {};
    try {
      const m = await this.admin.form(p.id); this.model.set(m);
      this.edited = Object.fromEntries(m.groups.flatMap((g) => g.fields).map((f) => [f.key, f.type === 'list' && Array.isArray(f.value) ? f.value.join(', ') : f.value]));
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected fields(g: { fields: import('./api').FormField[] }) { return visibleFields(g.fields, this.edited); }

  protected async act(fn: () => Promise<unknown>, ok: string) {
    this.admin.adminToken = this.session.adminToken();
    try { await fn(); this.note.set(ok); await this.refresh(); this.session.pluginsVersion.update((v) => v + 1); await this.session.refreshWorkflowsEnabled(true); const s = this.selected(); if (s) await this.open(this.plugins().find((p) => p.id === s.id)!).then(() => this.note.set(ok)); }
    catch (e) { this.note.set((e as Error).message); }
  }
  protected grants() { return { install: this.grantInstall, uiComponents: this.grantComponents, hooks: Object.keys(this.grantHooks).filter((h) => this.grantHooks[h]) }; }
  protected install() { const p = this.selected()!; return this.act(() => this.admin.install(p.id, this.grants()), `Installed ${p.name}.`); }
  protected save() { const p = this.selected()!; return this.act(() => this.admin.save(p.id, formValues(this.model()!, this.edited)), 'Settings saved.'); }
  protected enable() { const p = this.selected()!; return this.act(() => this.admin.enable(p.id, this.grants()), `Enabled ${p.name}.`); }
  protected disable() { const p = this.selected()!; return this.act(() => this.admin.disable(p.id), `Disabled ${p.name}: its slots are served by the base plugin again.`); }
}
