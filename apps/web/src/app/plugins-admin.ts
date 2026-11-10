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
  protected readonly confirmingUninstall = signal(false);
  protected readonly heldValues = signal<number | null>(null);
  protected readonly busyExport = signal(false);
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
    this.selected.set(p); this.note.set(''); this.grantInstall = false; this.grantComponents = false; this.grantHooks = {}; this.confirmingUninstall.set(false); this.heldValues.set(null);
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
  /** The mockup's lifecycle strip: 1 not installed, 2 installed, 3 enabled, 4 disabled (data kept), 5 uninstalled (table dropped). */
  protected lifecycle(p: PluginInfo) {
    const cur = p.base || p.enabled ? 3 : p.installed ? 2 : 1;
    return [
      { n: 1, label: 'Not installed', help: 'No table, no field, no trace on the surfaces.', cur: cur === 1 },
      { n: 2, label: 'Installed', help: 'Migrations applied: tables created. Fields and components still hidden until enabled.', cur: cur === 2 },
      { n: 3, label: 'Enabled', help: 'Configurable in Profile fields. Effective per the matrix after Apply.', cur: cur === 3 },
      { n: 4, label: 'Disabled', help: 'Hidden everywhere, not editable. Stored values are kept.', cur: false },
      { n: 5, label: 'Uninstalled', help: 'Tables and stored values dropped. Confirmation with an export first.', cur: false },
    ];
  }
  protected startUninstall() {
    this.confirmingUninstall.set(true); this.heldValues.set(null);
    const p = this.selected()!;
    this.admin.adminToken = this.session.adminToken();
    this.admin.profileValues(p.id).then((r) => this.heldValues.set(r.values)).catch(() => this.heldValues.set(null));
  }
  /** CSV of the plugin's profile values, one row per user and field, before the destructive uninstall. */
  protected async exportCsv() {
    const p = this.selected()!; const keys = (p.profileFields ?? []).map((k) => `${p.id}.${k}`);
    if (!keys.length) return;
    this.busyExport.set(true);
    try {
      const h: Record<string, string> = {}; const tok = this.session.adminToken(); if (tok) h['x-api-admin-token'] = tok;
      const users = (await this.api.raw<{ users: { id: string }[] }>('GET', '/users', undefined, h)).data.users;
      const csv = ['user,field,value'];
      for (const u of users) {
        const r = await this.api.raw<{ values?: Record<string, unknown> }>('GET', `/users/${encodeURIComponent(u.id)}/profile`, undefined, h);
        for (const k of keys) { const v = r.data.values?.[k]; if (v !== undefined && v !== null && v !== '') csv.push(`${u.id},${k},"${String(v).replace(/"/g, '""')}"`); }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv.join('\n')], { type: 'text/csv' }));
      a.download = `${p.id}-export.csv`; a.click(); URL.revokeObjectURL(a.href);
      this.note.set(`Export downloaded: ${csv.length - 1} value(s).`);
    } catch (e) { this.note.set((e as Error).message); } finally { this.busyExport.set(false); }
  }
  protected confirmUninstall() { const p = this.selected()!; return this.act(() => this.admin.uninstall(p.id), `Uninstalled ${p.id}: its tables and stored values are gone.`).then(() => this.confirmingUninstall.set(false)); }
  /** Manual cache refresh (Emmanuel's requirement): re-verify the shipped plugins and re-derive every inventory server-side, then reload. */
  protected refreshPlugins() { return this.act(() => this.admin.refresh(), 'Plugin catalogue and inventories refreshed.'); }
}
