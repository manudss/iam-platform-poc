import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface CatField { fullKey: string; plugin: string; label: string; type: string; klass: 'profile' | 'authority'; pii: string; storage: 'identities' | 'values' | 'table'; table?: string; section?: string; order?: number; help?: string }
export interface Setting { enabled: boolean; signup: 'off' | 'optional' | 'required'; selfView: boolean; selfEdit: boolean; adminView: boolean; adminEdit: boolean; section?: string; order?: number }
export interface EField { key: string; label: string; type: string; help?: string; options?: { value: string; label: string }[]; klass: string; editable: boolean; required?: boolean; visible: boolean; section?: string; group?: string; order?: number }
export interface ComponentInv { key: string; plugin: string; id: string; title: string; defaults: { self: string; admin: string }; effective: { self: string; admin: string }; order: number }

/** Authority fields never get "sign-up" or "user can edit": the screen disables them, and the server refuses them anyway. */
export const lockedFor = (f: CatField) => f.klass === 'authority';
export const SURFACES = ['manage', 'readonly', 'hidden'];

type Tab = 'fields' | 'components' | 'preview' | 'publish';

/**
 * Admin: the user profile, as the validated mockup lays it out - three tabs.
 * Fields: the grouped, draggable list of fields with a per-field side panel (surface matrix, lifecycle).
 * Components: which plugin components show on which surface, plus the enrolment stats an administrator gets.
 * Preview: the resulting forms, surface by surface, before saving. Saved on the working branch, live after Apply.
 */
@Component({
  selector: 'app-profile-fields', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Profile fields and components come from the core and from plugins. Choose for each one where it appears and who can edit it; reorder them by drag and drop. Changes go live only after Apply.</p>
  <p class="hint">Fields marked <b>authority</b> (department, manager, grade...) decide what someone may be or do. They can never be asked at sign-up nor edited by the person; only an administrator changes them. Roles and organizations are assigned separately, never from a profile form. Fictional data only: history keeps every value.</p>
  @if (note()) { <p role="status" class="msg" id="pf-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="pf-problem">{{problem()}}</p> }

  <nav class="pf-tabs" role="tablist" aria-label="Profile configuration">
    <button role="tab" type="button" id="pf-tab-fields" [attr.aria-selected]="tab()==='fields'" [class.active]="tab()==='fields'" (click)="tab.set('fields')">Fields</button>
    <button role="tab" type="button" id="pf-tab-components" [attr.aria-selected]="tab()==='components'" [class.active]="tab()==='components'" (click)="tab.set('components')">Components</button>
    <button role="tab" type="button" id="pf-tab-preview" [attr.aria-selected]="tab()==='preview'" [class.active]="tab()==='preview'" (click)="tab.set('preview')">Preview</button>
    <button role="tab" type="button" id="pf-tab-publish" [attr.aria-selected]="tab()==='publish'" [class.active]="tab()==='publish'" (click)="tab.set('publish')">Publish &amp; sign-up</button>
  </nav>

  @if (tab()==='fields') {
  <section class="card" id="pf-table"><div class="pf-fields-grid">
    <div class="pf-field-list" aria-label="Profile fields, grouped by section">
      <form class="pf-add-section" (ngSubmit)="addSection()"><label class="visually-labelled">New section <input name="pf-ns" [(ngModel)]="newSection" maxlength="80" placeholder="e.g. Emergency contact" /></label>
        <button id="pf-add-section" type="submit" class="secondary" [disabled]="s.branch()==='main' || !newSection.trim()">Add section</button>
        @if (sectionErr()) { <small role="alert" class="pf-err">{{sectionErr()}}</small> }</form>
      @for (g of groups(); track g.name) {
        <div class="pf-group-head" (dragover)="$event.preventDefault()" (drop)="dropOnSection(g.name)">
          @if (renaming()===g.name) {
            <form class="pf-rename" (ngSubmit)="commitRename(g.name)"><input name="pf-rn" [(ngModel)]="renameVal" maxlength="80" [attr.aria-label]="'New name for the section '+g.name" autofocus />
              <button type="submit" class="secondary">Save name</button><button type="button" class="secondary" (click)="renaming.set('')">Cancel</button></form>
          } @else {
            <h4 class="pf-group">{{g.name}} · {{g.fields.length}} field(s)</h4>
            <span class="pf-group-actions" [attr.data-section]="g.name">
              <button type="button" class="secondary icon" (click)="startRename(g.name)" [disabled]="s.branch()==='main'" [attr.aria-label]="'Rename the section '+g.name">Rename</button>
              <button type="button" class="secondary icon" (click)="moveSection(g.name,-1)" [disabled]="s.branch()==='main' || $first" [attr.aria-label]="'Move the section '+g.name+' up'">↑</button>
              <button type="button" class="secondary icon" (click)="moveSection(g.name,1)" [disabled]="s.branch()==='main' || $last" [attr.aria-label]="'Move the section '+g.name+' down'">↓</button>
              <button type="button" class="secondary icon" (click)="removeSection(g.name)" [disabled]="s.branch()==='main' || g.name==='Other'" [attr.aria-label]="(g.fields.length ? 'Dissolve the section ' : 'Remove the empty section ')+g.name">{{g.fields.length ? 'Dissolve' : 'Remove'}}</button>
            </span>
          }
        </div>
        @if (!g.fields.length) { <p class="hint pf-empty-section">Empty section. Drag a field here, or pick it in the field's Section box. Saved on this branch, including empty sections, after Save.</p> }
        @for (f of g.fields; track f.fullKey) { @if (cfg()[f.fullKey]; as c) {
          <div class="pf-field" [class.selected]="sel()===f.fullKey" [class.off]="!c.enabled" role="button" tabindex="0"
               draggable="true" (dragstart)="dragStart(f.fullKey)" (dragover)="$event.preventDefault()" (drop)="drop(f)" (click)="sel.set(f.fullKey)" (keydown.enter)="sel.set(f.fullKey)">
            <span class="pf-grip" aria-hidden="true">⋮⋮</span>
            <span class="pf-field-main"><b>{{f.label}}</b><br><small>{{f.fullKey}} · {{f.plugin}}@if (f.storage==='table') { · owns its table }</small></span>
            @if (f.plugin==='base') { <span class="pill">core</span> }
            @if (locked(f)) { <span class="pill warn">authority</span> }
            <span class="pill" [class.warn]="!c.enabled">{{c.enabled ? 'active' : 'hidden'}}</span>
          </div> } }
      } @empty { <p class="hint">{{loaded() ? 'No fields.' : 'Loading...'}}</p> }
      @if (inactive().length) { <h4>Installed plugins, not enabled</h4>
        @for (f of inactive(); track f.fullKey) { <div class="pf-field off" aria-disabled="true"><span class="pf-field-main"><b>{{f.label}}</b><br><small>{{f.fullKey}} · enable the plugin to configure this field</small></span><span class="pill">installed</span></div> }
      }
      <p class="hint">The directory core fields (name, e-mail) can be tuned but never disabled or hidden from administrators. Sections group the fields on My profile and in the user sheet; drag a row onto another to reorder, or onto another section to move it there.</p>
    </div>
    <aside class="pf-side" aria-label="Selected field">
      @if (selected(); as f) { @if (cfg()[f.fullKey]; as c) {
        <h3>{{f.label}}</h3>
        <p class="hint">{{f.plugin}} · {{f.fullKey}}@if (f.help) { <br>{{f.help}} }</p>
        <label class="inline"><input type="checkbox" name="pf-enabled" [ngModel]="c.enabled" (ngModelChange)="c.enabled=$event;dirty.set(true)" [disabled]="f.plugin==='base'" /> Field enabled</label>
        <h4>Where it shows</h4>
        <table class="pf-surface"><tbody>
          <tr><td>Sign-up</td><td>
            <span class="seg" role="radiogroup" aria-label="At sign-up"><label class="seg-opt"><input type="radio" [name]="'su-'+f.fullKey" value="off" [ngModel]="c.signup" (ngModelChange)="c.signup=$event;dirty.set(true)" [disabled]="(locked(f) || !c.enabled)" /><span>hidden</span></label><label class="seg-opt"><input type="radio" [name]="'su-'+f.fullKey" value="optional" [ngModel]="c.signup" (ngModelChange)="c.signup=$event;dirty.set(true)" [disabled]="(locked(f) || !c.enabled)" /><span>optional</span></label><label class="seg-opt"><input type="radio" [name]="'su-'+f.fullKey" value="required" [ngModel]="c.signup" (ngModelChange)="c.signup=$event;dirty.set(true)" [disabled]="(locked(f) || !c.enabled)" /><span>required</span></label></span>
            @if (locked(f)) { <br><small>never at sign-up (authority)</small> }</td></tr>
          <tr><td>My profile</td><td>
            <span class="seg" role="radiogroup" aria-label="On My profile"><label class="seg-opt"><input type="radio" [name]="'sf-'+f.fullKey" value="hidden" [ngModel]="surfaceState(c.selfView, c.selfEdit)" (ngModelChange)="setSurface(c,'self',$event)" [disabled]="(!c.enabled)" /><span>hidden</span></label><label class="seg-opt"><input type="radio" [name]="'sf-'+f.fullKey" value="visible" [ngModel]="surfaceState(c.selfView, c.selfEdit)" (ngModelChange)="setSurface(c,'self',$event)" [disabled]="(!c.enabled)" /><span>visible</span></label><label class="seg-opt"><input type="radio" [name]="'sf-'+f.fullKey" value="editable" [ngModel]="surfaceState(c.selfView, c.selfEdit)" (ngModelChange)="setSurface(c,'self',$event)" [disabled]="(!c.enabled) || (locked(f) || f.storage==='identities')" /><span>editable</span></label></span>
            @if (f.storage==='identities' && !locked(f)) { <br><small>edited later (needs re-authentication)</small> }</td></tr>
          <tr><td>User sheet (admin)</td><td>
            <span class="seg" role="radiogroup" aria-label="In the user sheet"><label class="seg-opt"><input type="radio" [name]="'sa-'+f.fullKey" value="hidden" [ngModel]="surfaceState(c.adminView, c.adminEdit)" (ngModelChange)="setSurface(c,'admin',$event)" [disabled]="(!c.enabled) || (f.plugin==='base')" /><span>hidden</span></label><label class="seg-opt"><input type="radio" [name]="'sa-'+f.fullKey" value="visible" [ngModel]="surfaceState(c.adminView, c.adminEdit)" (ngModelChange)="setSurface(c,'admin',$event)" [disabled]="(!c.enabled)" /><span>visible</span></label><label class="seg-opt"><input type="radio" [name]="'sa-'+f.fullKey" value="editable" [ngModel]="surfaceState(c.adminView, c.adminEdit)" (ngModelChange)="setSurface(c,'admin',$event)" [disabled]="(!c.enabled)" /><span>editable</span></label></span>
            @if (f.plugin==='base') { <br><small>always visible to administrators (core)</small> }</td></tr>
        </tbody></table>
        <h4>Placement</h4>
        <label>Section <input class="pf-section" name="pf-sec" [ngModel]="c.section" (ngModelChange)="c.section=$event;dirty.set(true)" [placeholder]="f.section ?? ''" list="pf-sections" /></label>
        <label>Order <input class="pf-order" type="number" min="0" max="999" name="pf-ord" [ngModel]="c.order ?? f.order ?? 500" (ngModelChange)="c.order=$event;dirty.set(true)" /></label>
        @if (f.plugin!=='base') {
          <h4>Plugin lifecycle</h4>
          <p class="pf-lifecycle" aria-label="Lifecycle">
            <span class="pf-step">installed</span> → <span class="pf-step" [class.on]="c.enabled">enabled</span> → <span class="pf-step" [class.on]="!c.enabled">disabled: values kept</span> → <span class="pf-step">uninstalled: table dropped</span>
          </p>
          <p class="hint">Disabling hides the field everywhere (sign-up, My profile, user sheet) without erasing anything. Uninstalling the plugin asks for confirmation and offers an export first.</p>
        }
      } } @else { <p class="hint">Select a field to tune where it shows.</p> }
    </aside>
  </div>
  <datalist id="pf-sections">@for (s of knownSections(); track s) { <option [value]="s"></option> }</datalist>
  </section> }

  @if (tab()==='components') {
  <section class="card" id="pf-components"><h3>Components</h3>
    <p class="hint">Plugins contribute whole components to the profile surfaces (picture, authenticator, PIN, password). Choose where each shows: <b>manage</b> (view + the actions the role allows), <b>readonly</b> (status only), <b>hidden</b>. The public sign-up form never loads a packaged component: plain fields only.</p>
    <div class="scroll"><table id="pf-components-table"><thead><tr><th>Component</th><th>Plugin</th><th>My profile</th><th>User sheet (admin)</th><th>Order</th></tr></thead><tbody>
    @for (c of comps(); track c.key) { <tr [attr.data-component]="c.key"><td>{{c.title}}<br><small>{{c.key}}</small></td><td>{{c.plugin}}</td>
      <td><span class="seg" role="radiogroup" [attr.aria-label]="'My profile '+c.title">@for (m of surfaces; track m) { <label class="seg-opt"><input type="radio" [name]="'cs'+c.key" [value]="m" [ngModel]="compsCfg()[c.key]?.self ?? c.defaults.self" (ngModelChange)="setComp(c.key,'self',$event)" /><span>{{surfaceLabel(m, 'self')}}</span></label> }</span></td>
      <td><span class="seg" role="radiogroup" [attr.aria-label]="'User sheet '+c.title">@for (m of surfaces; track m) { <label class="seg-opt"><input type="radio" [name]="'ca'+c.key" [value]="m" [ngModel]="compsCfg()[c.key]?.admin ?? c.defaults.admin" (ngModelChange)="setComp(c.key,'admin',$event)" /><span>{{surfaceLabel(m, 'admin')}}</span></label> }</span></td>
      <td><input class="pf-order" type="number" min="0" max="999" [name]="'co'+c.key" [ngModel]="compsCfg()[c.key]?.order ?? c.order" (ngModelChange)="setComp(c.key,'order',$event)" [attr.aria-label]="'Order '+c.key" /></td></tr> }
    @empty { <tr><td colspan="5">No plugin contributes a profile component on this branch.</td></tr> }
    </tbody></table></div>
    <h3>Enrolment statistics (admin view)</h3>
    <div class="stats">
      <p class="stat"><span class="n">{{totpEnrolled()}}</span><span class="l">authenticator apps enrolled</span></p>
      <p class="stat"><span class="n">{{pinEnrolled()}}</span><span class="l">PINs set</span></p>
      <p class="stat"><span class="n">{{emailEnrolled()}}</span><span class="l">e-mail addresses for codes</span></p>
    </div>
    <p class="hint">Counts over every enabled method instance. The detail stays with the person: an administrator sees statuses and can revoke, never a secret.</p>
  </section> }

  @if (tab()==='preview') {
  <section class="card" id="pf-preview"><h3>Preview (working branch)</h3>
    <p class="hint">The forms the current draft produces on each surface. Live surfaces keep the applied configuration until Apply.</p>
    <div class="pf-preview-cols">
      @for (p of preview(); track p.context) { <div class="pf-preview-col pf-form-preview"><h4>{{p.title}}</h4>
        @for (sec of previewSections(p.fields); track sec.name) {
          @if (sec.name) { <h5 class="pf-pv-section">{{sec.name}}</h5> }
          @for (f of sec.fields; track f.key) {
            <label class="pf-pv-field">{{f.label}}@if (f.required) { <b class="pf-req" title="required">*</b> }@if (!f.editable) { <small>(read only)</small> }
              @if (f.type==='select') { <select disabled aria-hidden="true"><option>-</option>@for (o of f.options ?? []; track o.value) { <option>{{o.label}}</option> }</select> }
              @else if (f.type==='image') { <span class="pf-pv-img">No picture</span> }
              @else { <input disabled [placeholder]="f.help ?? f.label" aria-hidden="true" /> }
            </label> }
        } @empty { <p class="hint">No field on this surface.</p> }
        @if (p.context==='signup' && hiddenAtSignup(); as h) { <p class="hint">{{h}} is hidden at sign-up (the matrix).</p> }
      </div> }
    </div></section> }

  @if (tab()==='publish') {
  <section class="card" id="pf-policy"><h3>How people's own edits are published</h3>
    <label>Policy <select name="selfEditPolicy" [(ngModel)]="policy" (ngModelChange)="dirty.set(true)" aria-label="Own-edit policy"><option value="immediate">Immediate: a person's edits go live at once (Dolt main)</option><option value="review">Validated: edits wait on a personal change set until a validator accepts them</option></select></label>
    <p class="hint">Live only after Save and Apply. With validation, each person's edits stay on an automatic personal Dolt branch (not a Git branch); a validator (an administrator other than the author) reviews the changes on the page Profile reviews, then accepts (merge into main) or refuses (the change set is deleted). Live policy: <b id="pf-livepolicy">{{livePolicy()}}</b>.</p>
  </section>
  <section class="card" id="pf-signup"><h3>Public sign-up</h3>
    <label class="inline"><input type="checkbox" name="signupopen" [(ngModel)]="signupOpen" (ngModelChange)="dirty.set(true)" /> Open the sign-up form (off by default)</label>
    <p class="hint">Live only after Save and Apply. Anyone with the link can then send a request: it needs e-mail confirmation (simulated here: the code goes to the demo outbox, not to a mailbox) and your approval. Approval creates an account with <b>no role, department or manager</b>. Fictional data only; do not open this on a public demo with real people.</p>
    <p class="hint">Live status: sign-up is <b id="pf-live">{{liveOpen() ? 'open' : 'closed'}}</b>.</p>
    @if (requests().length) { <div class="scroll"><table id="pf-requests"><thead><tr><th>Request</th><th>E-mail</th><th>Confirmed</th><th></th></tr></thead><tbody>
    @for (q of requests(); track q.id) { <tr><td>{{q.display_name}}<br><small>{{q.id}}</small></td><td>{{q.email}}</td><td>{{q.confirmed ? 'yes' : 'no'}}</td>
    <td><button class="secondary" (click)="decide(q.id, true)" [disabled]="!q.confirmed || s.branch()==='main'">Approve on this branch</button><button class="secondary" (click)="decide(q.id, false)">Reject</button></td></tr> }
    </tbody></table></div> } @else { <p class="hint">No pending request.</p> }
  </section> }

  <section class="card"><div class="row"><button id="pf-save" (click)="save()" [disabled]="busy() || !loaded() || s.branch()==='main'">Save on this branch</button>
  @if (dirty()) { <span class="pill warn">Unsaved edits</span> }</div>
  @if (s.branch()==='main') { <p class="hint">Choose a working branch (not main) to save. Changes become live only after Apply.</p> }
  <p class="hint">Plugins that declare fields or components must be enabled in Plugins to appear here. Disabling a plugin hides its contributions; stored values are kept. Uninstalling removes them with the plugin's configuration.</p></section>`,
})
export class ProfileFieldsPage {
  protected readonly s = inject(Session);
  protected inactive = signal<CatField[]>([]);
  protected cat = signal<CatField[]>([]); protected cfg = signal<Record<string, Setting>>({});
  protected comps = signal<ComponentInv[]>([]); protected compsCfg = signal<Record<string, { self?: string; admin?: string; order?: number }>>({});
  protected preview = signal<{ context: string; title: string; fields: EField[] }[]>([]);
  protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected dirty = signal(false); protected loaded = signal(false); protected signupOpen = false; protected policy: 'immediate' | 'review' = 'immediate'; protected livePolicy = signal('immediate'); protected liveOpen = signal(false); protected requests = signal<{ id: string; display_name: string; email: string; confirmed: boolean }[]>([]);
  protected readonly surfaces = SURFACES;
  protected readonly tab = signal<Tab>('fields');
  protected readonly sel = signal<string>('');
  private dragKey = '';
  private stats = signal<Record<string, { totp: number; pin: number; email: number }>>({});
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected locked = lockedFor;
  protected knownSections() { return [...new Set([...this.cat().map((f) => this.sectionOf(f)), ...this.pending()].filter((x): x is string => !!x))].sort(); }
  protected sectionOf(f: CatField) { return this.cfg()[f.fullKey]?.section || f.section || ''; }
  private sorted() { return [...this.cat()].sort((a, b) => (this.cfg()[a.fullKey]?.order ?? a.order ?? 500) - (this.cfg()[b.fullKey]?.order ?? b.order ?? 500) || a.fullKey.localeCompare(b.fullKey)); }
  protected readonly pending = signal<string[]>([]);
  protected readonly renaming = signal('');
  protected renameVal = '';
  protected newSection = '';
  protected readonly sectionErr = signal('');
  private fieldOrder(f: CatField) { return this.cfg()[f.fullKey]?.order ?? f.order ?? 500; }
  /** A section is the name its fields carry. Every field of one name is ONE group (ranked by its first field), so a name can never show twice. Explicit section order and empty sections are stored in the versioned configuration. */
  protected groups() {
    const by = new Map<string, CatField[]>();
    for (const f of this.sorted()) { const name = this.sectionOf(f) || 'Other'; (by.get(name) ?? by.set(name, []).get(name)!).push(f); }
    const out = [...by.entries()].map(([name, fields]) => ({ name, fields, rank: this.fieldOrder(fields[0]) })).sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name));
    const res: { name: string; fields: CatField[] }[] = out.map(({ name, fields }) => ({ name, fields }));
    for (const n of this.pending()) if (!by.has(n)) res.push({ name: n, fields: [] });
    return res.sort((a,b) => { const rank = (n: string) => { const i = this.pending().indexOf(n); return i < 0 ? 1000 : i; }; return rank(a.name) - rank(b.name); });
  }
  private sectionNames() { return this.groups().map((g) => g.name); }
  private validName(raw: string, except = ''): string | null {
    const n = raw.trim().replace(/\s+/g, ' ');
    if (!n) { this.sectionErr.set('A section needs a name.'); return null; }
    if (n.length > 80) { this.sectionErr.set('80 characters at most.'); return null; }
    if (this.sectionNames().some((x) => x.toLowerCase() === n.toLowerCase() && x !== except)) { this.sectionErr.set(`The section "${n}" already exists.`); return null; }
    this.sectionErr.set(''); return n;
  }
  protected addSection() { const n = this.validName(this.newSection); if (!n) return; this.pending.set([...this.sectionNames(), n]); this.dirty.set(true); this.newSection = ''; }
  protected startRename(name: string) { this.renaming.set(name); this.renameVal = name; this.sectionErr.set(''); }
  protected commitRename(old: string) {
    const n = this.validName(this.renameVal, old); if (!n) return;
    if (n !== old) {
      for (const f of this.cat()) if ((this.sectionOf(f) || 'Other') === old) this.cfg()[f.fullKey].section = n;
      this.pending.update((l) => l.map((x) => (x === old ? n : x)));
      this.cfg.update((m) => ({ ...m })); this.dirty.set(true);
    }
    this.renaming.set('');
  }
  /** Dissolve: the fields stay (never deleted), they move to "Other". An empty section is simply forgotten. */
  protected removeSection(name: string) {
    const fields = this.cat().filter((f) => (this.sectionOf(f) || 'Other') === name);
    if (fields.length && !confirm(`Dissolve the section "${name}"? Its ${fields.length} field(s) move to "Other"; nothing is deleted.`)) return;
    for (const f of fields) this.cfg()[f.fullKey].section = 'Other';
    this.pending.set(this.sectionNames().filter((x) => x !== name));
    this.cfg.update((m) => ({ ...m })); this.dirty.set(true);
  }
  /** Move a whole section up or down, then renumber every field 10 by 10 in the new section order. */
  protected moveSection(name: string, dir: -1 | 1) {
    const names = this.sectionNames(), i = names.indexOf(name), j = i + dir;
    if (i < 0 || j < 0 || j >= names.length) return;
    [names[i], names[j]] = [names[j], names[i]]; this.pending.set(names);
    let n = 0;
    for (const sec of names) for (const f of this.sorted().filter((x) => (this.sectionOf(x) || 'Other') === sec)) this.cfg()[f.fullKey].order = (++n) * 10;
    this.cfg.update((m) => ({ ...m })); this.dirty.set(true);
  }
  /** Drop on a section header: the field joins that section, at its end; every field is renumbered 10 by 10 in the current section order. */
  protected dropOnSection(name: string) {
    const key = this.dragKey; this.dragKey = '';
    const f = this.cat().find((x) => x.fullKey === key); if (!f) return;
    const order = this.sectionNames();
    this.cfg()[key].section = name;
    this.pending.set(order);
    let n = 0;
    for (const sec of order) {
      for (const x of this.sorted().filter((y) => y.fullKey !== key && (this.sectionOf(y) || 'Other') === sec)) this.cfg()[x.fullKey].order = (++n) * 10;
      if (sec === name) this.cfg()[key].order = (++n) * 10;
    }
    this.cfg.update((m) => ({ ...m })); this.dirty.set(true);
  }
  protected selected() { return this.cat().find((f) => f.fullKey === this.sel()); }
  protected surfaceLabel(m: string, who: 'self' | 'admin') { return m === 'manage' ? (who === 'admin' ? 'status + actions' : 'manage') : m === 'readonly' ? (who === 'admin' ? 'status only' : 'visible') : 'hidden'; }
  protected surfaceState(view: boolean, edit: boolean) { return !view ? 'hidden' : edit ? 'editable' : 'visible'; }
  protected setSurface(c: Setting, surface: 'self' | 'admin', v: string) {
    const view = v !== 'hidden', edit = v === 'editable';
    if (surface === 'self') { c.selfView = view; c.selfEdit = edit; } else { c.adminView = view; c.adminEdit = edit; }
    this.dirty.set(true);
  }
  protected dragStart(key: string) { this.dragKey = key; }
  /** Drop onto a row: move the dragged field just before it (adopting its section), then renumber 10 by 10. */
  protected drop(target: CatField) {
    const key = this.dragKey; this.dragKey = '';
    if (!key || key === target.fullKey) return;
    const flat = this.sorted().filter((f) => f.fullKey !== key);
    const at = flat.findIndex((f) => f.fullKey === target.fullKey);
    const moved = this.cat().find((f) => f.fullKey === key)!;
    flat.splice(at < 0 ? flat.length : at, 0, moved);
    flat.forEach((f, i) => { const c = this.cfg()[f.fullKey]; c.order = (i + 1) * 10; if (f.fullKey === key) c.section = this.sectionOf(target); });
    this.cfg.update((m) => ({ ...m })); this.dirty.set(true);
  }
  protected totpEnrolled() { return Object.values(this.stats()).reduce((n, s) => n + s.totp, 0); }
  protected pinEnrolled() { return Object.values(this.stats()).reduce((n, s) => n + s.pin, 0); }
  protected emailEnrolled() { return Object.values(this.stats()).reduce((n, s) => n + s.email, 0); }
  /** The image field configured nowhere at sign-up gets the mockup's note in the sign-up preview. */
  protected hiddenAtSignup() {
    const img = this.cat().find((f) => f.type === 'image' && this.cfg()[f.fullKey]?.enabled);
    if (!img || this.cfg()[img.fullKey]?.signup !== 'off') return '';
    const inSignup = this.preview().find((p) => p.context === 'signup')?.fields.some((f) => f.key === img.fullKey);
    return inSignup ? '' : img.label;
  }
  protected previewSections(fields: EField[]) {
    const out: { name: string; fields: EField[] }[] = [];
    for (const f of fields) {
      const name = f.section ?? f.group ?? '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.fields.push(f); else out.push({ name, fields: [f] });
    }
    return out;
  }
  protected setComp(key: string, k: 'self' | 'admin' | 'order', v: string | number) { this.compsCfg.update((m) => ({ ...m, [key]: { ...m[key], [k]: v } })); this.dirty.set(true); }
  protected async load() {
    this.loaded.set(false);
    try {
      const r = await this.s.api.raw<any>('GET', '/profile-fields', undefined, this.h());
      if (r.status >= 400) throw new Error(r.data.message ?? 'Cannot load');
      const defaults = (): Setting => ({ enabled: true, signup: 'off', selfView: true, selfEdit: false, adminView: true, adminEdit: true });
      const eff: Record<string, Setting> = {};
      for (const f of r.data.catalogue as CatField[]) eff[f.fullKey] = { ...defaults(), ...(r.data.working.settings?.[f.fullKey] ?? {}) };
      this.signupOpen = !!r.data.working.config.signup?.open; this.policy = r.data.working.config.selfEditPolicy === 'review' ? 'review' : 'immediate'; this.livePolicy.set(r.data.live.config.selfEditPolicy === 'review' ? 'review' : 'immediate'); this.liveOpen.set(!!r.data.live.config.signup?.open); void this.loadRequests();
      this.pending.set([...(r.data.working.config.sections ?? [])]);
      this.inactive.set(r.data.inactiveCatalogue ?? []);
      this.cat.set(r.data.catalogue); this.cfg.set(eff); this.compsCfg.set({ ...(r.data.working.config.components ?? {}) });
      if (!this.sel() && r.data.catalogue.length) this.sel.set((r.data.catalogue as CatField[])[0].fullKey);
      this.dirty.set(false); this.problem.set(''); this.loaded.set(true);
      void this.loadComps(); void this.loadPreview(); void this.loadStats();
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected async loadComps() {
    try { const r = await this.s.api.raw<any>('GET', '/profile-components-inventory', undefined, this.h()); if (r.status < 400) this.comps.set(r.data.components ?? []); } catch { this.comps.set([]); }
  }
  protected async loadStats() {
    try { const r = await this.s.api.raw<any>('GET', '/auth/enrollment-stats', undefined, this.h()); if (r.status < 400) this.stats.set(r.data.instances ?? {}); } catch { /* stats stay at zero */ }
  }
  protected async loadPreview() {
    const titles: Record<string, string> = { signup: 'Sign-up form', self: 'My profile (person)', admin: 'User sheet (admin)' };
    const out = [];
    for (const context of ['signup', 'self', 'admin']) {
      try {
        const r = await this.s.api.raw<any>('GET', `/profile-schema?context=${context}&ref=work`);
        out.push({ context, title: titles[context], fields: r.status < 400 ? (r.data.fields ?? []) : [] });
      } catch { out.push({ context, title: titles[context], fields: [] }); }
    }
    this.preview.set(out);
  }
  protected async loadRequests() { try { const r = await this.s.api.raw<any>('GET', '/signup/requests', undefined, this.h()); this.requests.set(r.status < 400 ? r.data.requests : []); } catch { this.requests.set([]); } }
  protected async decide(id: string, ok: boolean) {
    try {
      const r = await this.s.api.raw<any>(ok ? 'POST' : 'DELETE', `/signup/requests/${encodeURIComponent(id)}${ok ? '/approve' : ''}`, ok ? {} : undefined, this.h());
      if (r.status >= 400) throw new Error(r.data.message ?? 'Refused');
      this.note.set(ok ? 'Account created on the working branch with no role. It can sign in after Apply.' : 'Request rejected.'); await this.loadRequests();
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected async save() {
    this.busy.set(true);
    try {
      const r = await this.s.api.raw<any>('PUT', '/profile-fields', { config: { sections: this.sectionNames(), fields: this.cfg(), signup: { open: this.signupOpen }, selfEditPolicy: this.policy, components: this.compsCfg() } }, this.h());
      if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused');
      this.note.set('Saved on the working branch. Nothing changes for people until Apply.'); this.problem.set(''); await this.load();
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
}
