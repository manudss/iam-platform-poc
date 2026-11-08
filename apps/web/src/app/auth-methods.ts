import { Component, effect, inject, signal } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { SessionSettings } from './session-settings';
import { Availability, Dropped, Entry, addInstance, deleteChain, deleteMethod, entries, instanceCount, minChainLevel, moveInUse, reconcile, removeFromList, syncSolo, useEntry } from './auth-model';
import { LevelGauge, LevelSelect } from './level-select';

export interface MethodInstance { id: string; type: string; name: string; enabled: boolean; level: number; config: Record<string, any> }
export interface Chain { id: string; name: string; enabled: boolean; steps: string[]; level: number; note?: string }
export interface AuthnConfig { methods: MethodInstance[]; chains: Chain[]; defaultChain: string | null }
export interface Analysis { id: string; declaredLevel: number; effectiveLevel: number; maxStepLevel: number; verifiedFactors: string[]; simulatedSteps: string[]; mfa: boolean; warnings: string[]; basis: string }
export interface SettingField { key: string; type: string; label: string; help?: string; group?: string; default?: unknown; options?: { value: string; label: string }[]; min?: number; max?: number; visibleIf?: { key: string; equals: unknown } }
export interface CatalogueEntry { id: string; name: string; description: string; factor: string; maturity: 'implemented' | 'catalogue'; suggestedLevel: number; provisioning: string; instances?: 'single' | 'multiple'; settings: SettingField[]; simulatedByDefault: boolean }

/** Suggestion only: a chain cannot be weaker than its strongest step, so that is the starting value. The administrator sets the real level. */
export const suggestChainLevel = (cfg: AuthnConfig, steps: string[]) => Math.max(1, ...steps.map((s) => cfg.methods.find((m) => m.id === s)?.level ?? 1));
export const slug = (s: string, taken: string[]) => { const b = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'item'; let id = b, i = 2; while (taken.includes(id)) id = `${b}-${i++}`; return id; };

/**
 * Authentication methods: ONE ordered list of what people can sign in with (a chain is a method too), "In use" and "Not in use".
 * The form of a method (settings, extra blocks) comes from its plugin; name, level, recommended and position are common to all.
 * Drag and drop is doubled by buttons and arrow keys so every action works without a mouse. Pure list logic: auth-model.ts.
 */
@Component({
  selector: 'app-auth-methods', imports: [FormsModule, SessionSettings, LevelSelect, LevelGauge], styleUrl: './auth-methods.css', templateUrl: './auth-methods.html',
})
export class AuthMethodsPage {
  protected readonly s = inject(Session);
  protected cfg = signal<AuthnConfig>({ methods: [], chains: [], defaultChain: null });
  protected catalogue = signal<CatalogueEntry[]>([]);
  protected analyses = signal<Analysis[]>([]);
  protected avail = signal<Availability | null>(null);
  protected live = signal<{ config: AuthnConfig; signInMode: string } | null>(null);
  protected saved = '';
  protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected dirty = signal(false); protected loaded = signal(false); protected seeded = signal(false);
  protected dropped = signal<Dropped[]>([]);
  protected editKey = signal(''); protected panel = signal<'' | 'edit' | 'new-type' | 'new-form' | 'new-chain' | 'preview' | 'outbox'>('');
  protected announce = signal('');
  protected dragKey = ''; protected dropAt = signal(-1);
  protected newType = signal(''); protected newName = ''; protected newLevel = signal(5); protected newConfig: Record<string, any> = {}; protected newUse = true; protected newPos = 0;
  protected chainName = ''; protected stepPick = '';
  protected previewView = signal<'list' | 'step'>('list'); protected previewDark = signal(false); protected previewStep = signal(0);
  protected shown = signal(''); protected allShown = signal<string[]>([]); protected outbox = signal<{ at: string; to: string; user: string; text: string }[] | null>(null);
  protected enrollUser = 'demo-alice'; protected enrollEmail = ''; protected enrollPin = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }

  // ---- derived views ----
  protected all() { return entries(this.cfg(), this.avail()); }
  protected used() { return this.all().filter((e) => e.inUse); }
  protected unused() { return this.all().filter((e) => !e.inUse); }
  protected current(): Entry | undefined { return this.all().find((e) => e.key === this.editKey()); }
  protected method(id: string | undefined) { return this.cfg().methods.find((m) => m.id === id); }
  protected chain(e: Entry | undefined) { return e?.chainId ? this.cfg().chains.find((c) => c.id === e.chainId) : undefined; }
  protected implemented() { return this.catalogue().filter((t) => t.maturity === 'implemented'); }
  protected entryType(id: string) { return this.catalogue().find((t) => t.id === id); }
  protected typeName(id: string) { return this.entryType(id)?.name ?? id; }
  protected factor(id: string) { return this.entryType(id)?.factor ?? ''; }
  protected methodName(id: string) { return this.method(id)?.name ?? id; }
  protected methodLevel(id: string) { return this.method(id)?.level ?? 0; }
  protected methodInUse(id: string) { return this.used().some((e) => e.stepIds.length === 1 && e.stepIds[0] === id); }
  protected count(type: string) { return instanceCount(this.cfg(), type); }
  protected locked(t: CatalogueEntry) { return t.instances === 'single' && this.count(t.id) >= 1; }
  protected sim(m: MethodInstance | undefined) { return !!m && m.type === 'email-otp' && (m.config['delivery'] ?? 'demo-outbox') === 'demo-outbox'; }
  protected simEntry(e: Entry) { return e.stepIds.some((id) => this.sim(this.method(id))); }
  protected analysis(id: string | undefined) { return this.analyses().find((a) => a.id === id); }
  protected sub(e: Entry) { return e.kind === 'chain' ? e.stepIds.map((id) => this.methodName(id)).join(' \u2192 ') : this.typeName(this.method(e.methodId)?.type ?? ''); }
  protected steps(e: Entry) { return e.stepIds.length; }
  protected groups(m: MethodInstance | undefined) {
    if (!m) return [] as { name: string; fields: SettingField[] }[];
    const t = this.entryType(m.type); const out: { name: string; fields: SettingField[] }[] = [];
    for (const f of t?.settings ?? []) {
      if (f.visibleIf && (m.config[f.visibleIf.key] ?? t!.settings.find((x) => x.key === f.visibleIf!.key)?.default) !== f.visibleIf.equals) continue;
      const g = f.group ?? 'Settings'; let b = out.find((x) => x.name === g); if (!b) out.push(b = { name: g, fields: [] }); b.fields.push(f);
    }
    return out;
  }
  protected isRecommended(e: Entry) { return !!e.chainId && this.cfg().defaultChain === e.chainId; }
  protected differsFromLive() { return !!this.live() && JSON.stringify(this.cfg()) !== JSON.stringify(this.live()!.config); }
  protected emptyList() { return this.loaded() && !this.used().length; }
  protected pluginOf(m: MethodInstance | undefined) { return m ? (this.avail()?.methods[m.id]?.plugin ?? '') : ''; }

  // ---- loading, saving ----
  protected async load() {
    this.loaded.set(false);
    try {
      const r = await this.s.api.raw<any>('GET', '/auth', undefined, this.h());
      this.catalogue.set(r.data.catalogue); this.cfg.set(r.data.working.config); this.analyses.set(r.data.working.analyses); this.avail.set(r.data.working.availability ?? null);
      this.live.set({ config: r.data.live.config, signInMode: r.data.live.signInMode });
      this.saved = r.data.working.seeded ? '' : JSON.stringify(r.data.working.config); this.seeded.set(!!r.data.working.seeded); this.dirty.set(!!r.data.working.seeded); this.problem.set('');
      // A plugin was disabled since the last save: its methods and chains leave the list now, with an explicit message.
      const d = reconcile(this.cfg(), this.avail()); this.dropped.set(d); if (d.length) this.touch();
      this.loaded.set(true);
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected touch() { this.cfg.set({ ...this.cfg() }); this.dirty.set(JSON.stringify(this.cfg()) !== this.saved); clearTimeout(this.timer); this.timer = setTimeout(() => void this.analyze(), 250); this.pushPreview(); }
  private async analyze() {
    if (this.cfg().chains.some((c) => !c.steps.length)) { this.problem.set('A chain needs at least one step.'); return; }
    try { const r = await this.s.api.raw<any>('POST', '/auth/analyze', { config: this.cfg() }, this.h()); this.analyses.set(r.data.analyses); this.problem.set(''); }
    catch (e) { this.problem.set((e as Error).message); }
  }
  protected async save() {
    this.busy.set(true); this.note.set('');
    try {
      const r = await this.s.api.raw<any>('PUT', '/auth', { config: this.cfg() }, this.h());
      this.cfg.set(r.data.config); this.analyses.set(r.data.analyses); this.saved = JSON.stringify(r.data.config); this.dirty.set(false); this.problem.set('');
      this.note.set('Saved on the working branch. Sign-in does not change until Apply.'); await this.load();
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }

  // ---- list actions (buttons, drag and drop and keys share them) ----
  protected use(e: Entry, pos?: number) {
    if (!e.available) { this.problem.set(`${e.name} needs a plugin that is not active. Enable the plugin to use it.`); return; }
    const id = useEntry(this.cfg(), e, this.avail(), pos); this.dropped.set([]); this.touch(); this.say(`${e.name} is now in the sign-in list${id ? '' : ''}.`);
  }
  protected unuse(e: Entry) { removeFromList(this.cfg(), e); if (this.editKey() === e.key) this.close(); this.touch(); this.say(`${e.name} left the sign-in list.`); }
  protected move(e: Entry, d: number) {
    const i = this.used().findIndex((x) => x.key === e.key), j = i + d; if (i < 0 || j < 0 || j >= this.used().length) return;
    moveInUse(this.cfg(), e, j); this.touch(); this.say(`${e.name} is now number ${j + 1} of ${this.used().length}.`);
  }
  protected handleKey(ev: KeyboardEvent, e: Entry) {
    if (ev.key === 'ArrowUp') { ev.preventDefault(); this.move(e, -1); } else if (ev.key === 'ArrowDown') { ev.preventDefault(); this.move(e, 1); }
  }
  protected say(m: string) { this.announce.set(m); }
  protected dragStart(ev: DragEvent, e: Entry) { this.dragKey = e.key; ev.dataTransfer?.setData('text/plain', e.key); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'; }
  protected dragEnd() { this.dragKey = ''; this.dropAt.set(-1); }
  protected overItem(ev: DragEvent, i: number) { ev.preventDefault(); const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); this.dropAt.set(ev.clientY < r.top + r.height / 2 ? i : i + 1); }
  protected overZone(ev: DragEvent) { ev.preventDefault(); }
  protected dropUsed(ev: DragEvent) {
    ev.preventDefault(); const e = this.all().find((x) => x.key === (this.dragKey || ev.dataTransfer?.getData('text/plain'))); const at = this.dropAt() < 0 ? this.used().length : this.dropAt();
    this.dragEnd(); if (!e) return;
    if (e.inUse) { const from = this.used().findIndex((x) => x.key === e.key); moveInUse(this.cfg(), e, at > from ? at - 1 : at); this.touch(); this.say(`${e.name} moved.`); } else this.use(e, at);
  }
  protected dropUnused(ev: DragEvent) { ev.preventDefault(); const e = this.all().find((x) => x.key === (this.dragKey || ev.dataTransfer?.getData('text/plain'))); this.dragEnd(); if (e?.inUse) this.unuse(e); }

  // ---- drawers and dialogs ----
  protected edit(e: Entry) { this.editKey.set(e.key); this.panel.set('edit'); this.shown.set(''); this.stepPick = ''; }
  protected close() { this.panel.set(''); this.editKey.set(''); }
  protected openNew() { this.panel.set('new-type'); }
  protected pickType(t: CatalogueEntry) {
    if (t.maturity !== 'implemented' || this.locked(t)) return;
    this.newType.set(t.id); this.newName = ''; this.newLevel.set(t.suggestedLevel); this.newUse = true; this.newPos = this.used().length + 1;
    this.newConfig = Object.fromEntries(t.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])); this.panel.set('new-form');
  }
  protected newEntry() { return this.entryType(this.newType()); }
  protected newGroups() {
    const t = this.newEntry(); const out: { name: string; fields: SettingField[] }[] = [];
    for (const f of t?.settings ?? []) {
      if (f.visibleIf && (this.newConfig[f.visibleIf.key] ?? t!.settings.find((x) => x.key === f.visibleIf!.key)?.default) !== f.visibleIf.equals) continue;
      const g = f.group ?? 'Settings'; let b = out.find((x) => x.name === g); if (!b) out.push(b = { name: g, fields: [] }); b.fields.push(f);
    }
    return out;
  }
  protected createInstance() {
    const t = this.newEntry(); if (!t) return; const c = this.cfg();
    const m = addInstance(c, t, this.newName, this.newLevel(), this.newConfig);
    if (!m) { this.problem.set(`${t.name} allows a single instance and it already exists.`); return; }
    if (this.newUse) { const e = entries(c, this.avail()).find((x) => x.key === `m:${m.id}`); if (e) useEntry(c, e, this.avail(), Math.max(0, this.newPos - 1)); }
    this.touch(); this.close();
  }
  protected createChain() {
    const c = this.cfg(), name = this.chainName.trim() || 'New chain';
    c.chains.push({ id: slug(name, c.chains.map((x) => x.id)), name, enabled: false, steps: [], level: 1 }); this.chainName = ''; this.touch();
    const e = this.all().find((x) => x.chainId === c.chains[c.chains.length - 1].id); if (e) this.edit(e);
  }
  protected setLevel(e: Entry, n: number) {
    const m = this.method(e.methodId), ch = this.chain(e);
    if (m) { m.level = n; syncSolo(this.cfg(), m.id); } else if (ch) { ch.level = Math.max(n, minChainLevel(this.cfg(), ch.steps)); }
    this.touch();
  }
  protected rename(e: Entry, v: string) { const m = this.method(e.methodId), ch = this.chain(e); if (m) { m.name = v; syncSolo(this.cfg(), m.id); } else if (ch) ch.name = v; this.touch(); }
  protected setRecommended(e: Entry, on: boolean) { if (!e.chainId) return; this.cfg().defaultChain = on ? e.chainId : (this.cfg().defaultChain === e.chainId ? null : this.cfg().defaultChain); this.touch(); }
  protected setConfig(m: MethodInstance, key: string, v: unknown) { m.config[key] = v; this.touch(); }
  protected addStep(e: Entry) {
    const ch = this.chain(e); const id = this.stepPick || this.cfg().methods.find((m) => !ch?.steps.includes(m.id))?.id; if (!ch || !id || ch.steps.includes(id) || ch.steps.length >= 6) return;
    ch.steps.push(id); ch.level = Math.max(ch.level, minChainLevel(this.cfg(), ch.steps)); this.stepPick = ''; this.touch();
  }
  protected removeStep(e: Entry, i: number) { const ch = this.chain(e); if (!ch) return; ch.steps.splice(i, 1); if (!ch.steps.length) ch.enabled = false; this.touch(); }
  protected moveStep(e: Entry, i: number, d: number) { const ch = this.chain(e); if (!ch) return; const j = i + d; if (j < 0 || j >= ch.steps.length) return; [ch.steps[i], ch.steps[j]] = [ch.steps[j], ch.steps[i]]; this.touch(); }
  protected stepChoices(e: Entry) { const ch = this.chain(e); return this.cfg().methods.filter((m) => !ch?.steps.includes(m.id)); }
  protected deleteEntry(e: Entry) {
    if (e.kind === 'chain' && e.chainId) deleteChain(this.cfg(), e.chainId);
    else if (e.methodId && !deleteMethod(this.cfg(), e.methodId)) { this.problem.set(`${e.name} is a step of a longer chain: remove it from that chain first.`); return; }
    this.close(); this.touch();
  }
  protected usedBy(e: Entry) { return this.cfg().chains.filter((c) => c.steps.length > 1 && e.methodId && c.steps.includes(e.methodId)).map((c) => c.name); }

  // ---- preview: the real public sign-in page in an iframe (preview mode), fed with this draft, nothing sent ----
  protected openPreview(e: Entry) { this.editKey.set(e.key); this.previewView.set('list'); this.previewStep.set(0); this.panel.set('preview'); }
  private readonly san = inject(DomSanitizer);
  /** Fixed same-origin URL, never built from data. */
  protected readonly previewSrcSafe: SafeResourceUrl = this.san.bypassSecurityTrustResourceUrl('/login?preview=1');
  protected minLevel(e: Entry) { const ch = this.chain(e); return ch ? minChainLevel(this.cfg(), ch.steps) : 1; }
  protected previewChains() {
    const cfg = this.cfg();
    return this.used().map((e) => {
      const a = this.analysis(e.chainId); const ch = cfg.chains.find((c) => c.id === e.chainId)!;
      return { id: ch.id, name: ch.name, declaredLevel: ch.level, effectiveLevel: a?.effectiveLevel ?? ch.level, mfa: !!a?.mfa, simulated: (a?.simulatedSteps.length ?? 0) > 0, recommended: cfg.defaultChain === ch.id,
        steps: ch.steps.map((id) => { const m = cfg.methods.find((x) => x.id === id)!; return { name: m.name, type: m.type, simulated: this.sim(m) }; }) };
    });
  }
  /** Same-origin message to the preview iframe. The login page ignores messages from any other origin or frame. */
  protected pushPreview(frame?: HTMLIFrameElement | null) {
    const f = frame ?? (document.getElementById('authn-preview-frame') as HTMLIFrameElement | null); if (!f?.contentWindow || this.panel() !== 'preview') return;
    const e = this.current(); const chains = this.previewChains(); const hl = e?.chainId;
    f.contentWindow.postMessage({ type: 'iam-preview', chains: hl && !chains.some((c) => c.id === hl) && e ? [...chains, this.draftChain(e)] : chains, highlight: hl, view: this.previewView(), step: this.previewStep(), dark: this.previewDark() }, location.origin);
  }
  private draftChain(e: Entry) {
    const cfg = this.cfg(), ch = cfg.chains.find((c) => c.id === e.chainId); if (!ch) return { id: e.key, name: e.name, declaredLevel: e.level, effectiveLevel: e.level, mfa: false, simulated: false, recommended: false, steps: [] };
    return { id: ch.id, name: ch.name, declaredLevel: ch.level, effectiveLevel: ch.level, mfa: false, simulated: false, recommended: false, steps: ch.steps.map((id) => { const m = cfg.methods.find((x) => x.id === id)!; return { name: m.name, type: m.type, simulated: this.sim(m) }; }) };
  }
  protected setView(v: 'list' | 'step') { this.previewView.set(v); this.pushPreview(); }
  protected toggleDark() { this.previewDark.set(!this.previewDark()); this.pushPreview(); }
  protected stepNext(d: number) { const e = this.current(); const n = e?.stepIds.length ?? 1; this.previewStep.set(Math.max(0, Math.min(n - 1, this.previewStep() + d))); this.pushPreview(); }

  // ---- demo provisioning and outbox (unchanged behaviour) ----
  protected async enroll(m: MethodInstance) {
    if (this.dirty()) { this.problem.set('Save the method first, then provision.'); return; }
    this.busy.set(true); this.shown.set('');
    try {
      const body: Record<string, unknown> = m.type === 'email-otp' ? { email: this.enrollEmail } : m.type === 'digit-code' ? (this.enrollPin ? { pin: this.enrollPin } : {}) : {};
      const r = await this.s.api.raw<any>('POST', `/auth/enrollments/${encodeURIComponent(this.enrollUser)}/${encodeURIComponent(m.id)}`, body, this.h());
      const o = r.data.shownOnce; this.enrollPin = '';
      this.shown.set(o ? (o.secret ? `Authenticator secret for ${this.enrollUser}: ${o.secret}` : `PIN for ${this.enrollUser}: ${o.pin}`) : `Enrolled ${this.enrollUser} for ${m.name}.`);
      this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
  /** Demo only: enrolls demo-alice in every method that needs enrollment. Secrets and PINs are shown once, here. */
  protected async enrollAll() {
    this.busy.set(true); const lines: string[] = [];
    try {
      for (const m of this.cfg().methods) {
        const type = this.entryType(m.type); if (type?.provisioning !== 'admin-demo') continue;
        const body = m.type === 'email-otp' ? { email: 'alice@example.invalid' } : {};
        const r = await this.s.api.raw<any>('POST', `/auth/enrollments/demo-alice/${encodeURIComponent(m.id)}`, body, this.h()); const o = r.data.shownOnce;
        lines.push(o?.secret ? `${m.name}: authenticator secret ${o.secret}` : o?.pin ? `${m.name}: PIN ${o.pin}` : `${m.name}: enrolled`);
      }
      this.allShown.set(lines); this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async showOutbox() { try { this.outbox.set((await this.s.api.raw<any>('GET', '/auth/outbox', undefined, this.h())).data.messages); this.panel.set('outbox'); this.editKey.set(''); } catch (e) { this.problem.set((e as Error).message); } }
}
