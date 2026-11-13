import { Component, EventEmitter, Input, Output, computed, inject, signal } from '@angular/core';
import { Session } from './session';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiClient, FormModel, PluginAdminClient, PluginInfo, formValues, visibleFields } from './api';

/**
 * Generic plugin administration. Nothing here is specific to one plugin: the list, the grant prompts and the settings form
 * are all built from what the API returns (the plugin manifests). A new plugin shows up here with no change to the console.
 *
 * The gallery (validated mockup, sheet A): searchable/filterable cards grouped by family, slot, state or publisher,
 * a fault banner while a plugin is refusing requests, and a pending panel fed by /plugins/pending (changes staged
 * on the working branch but not applied to main yet).
 */
@Component({
  selector: 'app-plugins-admin',
  imports: [FormsModule, RouterLink],
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
  /** Gallery controls. */
  protected search = '';
  protected grouping: 'family' | 'slot' | 'state' | 'publisher' = 'family';
  protected stateFilter: 'all' | 'enabled' | 'installed' | 'not-installed' | 'faulted' | 'pending' = 'all';
  protected hideBase = false;
  protected readonly pending = signal<{ id: string; name: string; changes: { kind: string; detail: string }[] }[]>([]);
  protected readonly pendingBranch = signal('main');
  /** Drawer tab (validated mockup, sheet A): overview, settings, lifecycle & permissions, dependencies, activity. */
  protected readonly tab = signal<'apercu' | 'reglages' | 'cycle' | 'deps' | 'activite'>('apercu');
  protected edited: Record<string, unknown> = {};
  protected grantInstall = false;
  protected grantComponents = false;
  protected grantHooks: Record<string, boolean> = {};

  /** Family label from the manifest kinds (directory/profile/auth-method…), as in the validated mockup. */
  private static readonly FAMILY_ORDER = ['Authentification', 'Profil & annuaire', 'Notifications', 'Workflows', 'Connecteurs & SSO', 'Politiques & risque', 'Interfaces', 'Autres'];
  protected family(p: PluginInfo): string {
    const k = p.kinds;
    if (k.includes('auth-method') || k.includes('authn')) return 'Authentification';
    if (k.includes('directory') || k.includes('profile')) return 'Profil & annuaire';
    if (k.includes('notify') || k.includes('mail')) return 'Notifications';
    if (k.includes('workflow')) return 'Workflows';
    if (k.includes('connector') || k.includes('sso')) return 'Connecteurs & SSO';
    if (k.includes('policy') || k.includes('risk')) return 'Politiques & risque';
    if (k.includes('ui')) return 'Interfaces';
    return 'Autres';
  }
  protected stateLabel(p: PluginInfo): string {
    return p.base ? 'Base · toujours actif' : p.faulted ? 'En défaut' : p.enabled ? 'Activé' : p.installed ? 'Installé' : 'Non installé';
  }
  private matches(p: PluginInfo): boolean {
    if (this.hideBase && p.base) return false;
    if (this.stateFilter !== 'all') {
      const st = this.stateFilter === 'enabled' ? p.enabled || p.base : this.stateFilter === 'installed' ? p.installed && !p.enabled : this.stateFilter === 'not-installed' ? !p.installed : this.stateFilter === 'faulted' ? !!p.faulted : this.pendingIds().has(p.id);
      if (!st) return false;
    }
    const q = this.search.trim().toLowerCase();
    if (!q) return true;
    return [p.name, p.id, p.description, p.publisher, ...p.kinds, ...p.provides].filter(Boolean).join(' ').toLowerCase().includes(q);
  }
  /** The grouped, filtered gallery. */
  protected readonly grouped = computed(() => {
    const key = (p: PluginInfo) => this.grouping === 'family' ? this.family(p) : this.grouping === 'slot' ? (p.provides[0] ? `Slot ${p.provides[0]}` : 'Sans slot') : this.grouping === 'publisher' ? (p.publisher || 'Inconnu') : this.stateLabel(p);
    const map = new Map<string, PluginInfo[]>();
    for (const p of this.plugins()) if (this.matches(p)) { const k = key(p); if (!map.has(k)) map.set(k, []); map.get(k)!.push(p); }
    const order = this.grouping === 'family' ? PluginsAdmin.FAMILY_ORDER : undefined;
    return [...map.entries()].sort((a, b) => order ? order.indexOf(a[0]) - order.indexOf(b[0]) : a[0].localeCompare(b[0])).map(([label, items]) => ({ label, items }));
  });
  protected readonly faulted = computed(() => this.plugins().filter((p) => p.faulted));
  protected readonly pendingIds = computed(() => new Set(this.pending().map((x) => x.id)));


  async ngOnInit() {
    this.admin = new PluginAdminClient(this.api); await this.refresh();
    const want = this.plugins().find((p) => p.id === this.pluginId); if (want) await this.open(want, false);
  }

  protected async refresh() {
    try {
      this.plugins.set(await this.admin.list());
      try { const r = await this.admin.pending(); this.pending.set(r.pending ?? []); this.pendingBranch.set(r.branch ?? 'main'); } catch { this.pending.set([]); }
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected async open(p: PluginInfo, announce = true) {
    if (announce) this.opened.emit(p.id);
    this.selected.set(p); this.tab.set('apercu'); this.note.set(''); this.grantInstall = false; this.grantComponents = false; this.grantHooks = {}; this.confirmingUninstall.set(false); this.heldValues.set(null);
    try {
      const m = await this.admin.form(p.id); this.model.set(m);
      this.edited = Object.fromEntries(m.groups.flatMap((g) => g.fields).map((f) => [f.key, f.type === 'list' && Array.isArray(f.value) ? f.value.join(', ') : f.value]));
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected close() { this.selected.set(null); this.opened.emit(null); }
  /** What the admin already granted this plugin (the permissions list of the lifecycle tab). */
  protected grantedPermissions(p: PluginInfo): { label: string; detail: string }[] {
    const out: { label: string; detail: string }[] = [];
    if (p.grants.install) out.push({ label: "Migrations d'installation", detail: 'Tables préfixées par son id, créées à l\'installation.' });
    for (const h of p.grants.hooks ?? []) out.push({ label: `Hook sensible : ${h}`, detail: 'Reçoit l\'événement à chaque appel.' });
    if (p.grants.uiComponents) out.push({ label: 'Composants UI packagés', detail: 'Peut afficher ses écrans et composants dans la console.' });
    return out;
  }
  /** The change staged on the working branch for this plugin, when any (the drawer shows it as a warning). */
  protected pendingChange(p: PluginInfo) { return this.pending().find((x) => x.id === p.id); }
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
  /** CSV of the plugin's profile values, one row per user and field, generated server side before the destructive uninstall. */
  protected exportCsv() {
    const p = this.selected()!;
    this.busyExport.set(true);
    const h: Record<string, string> = {}; const tok = this.session.adminToken(); if (tok) h['x-api-admin-token'] = tok;
    this.api.rawText('GET', `/plugins/${p.id}/export`, h).then((csv) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `${p.id}-export.csv`; a.click(); URL.revokeObjectURL(a.href);
      this.note.set('Export downloaded.');
    }).catch((e) => this.note.set((e as Error).message)).finally(() => this.busyExport.set(false));
  }
  protected confirmUninstall() { const p = this.selected()!; return this.act(() => this.admin.uninstall(p.id), `Uninstalled ${p.id}: its tables and stored values are gone.`).then(() => this.confirmingUninstall.set(false)); }
  /** Manual cache refresh (Emmanuel's requirement): re-verify the shipped plugins and re-derive every inventory server-side, then reload. */
  protected refreshPlugins() { return this.act(() => this.admin.refresh(), 'Plugin catalogue and inventories refreshed.'); }
}
