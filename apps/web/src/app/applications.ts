import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export type Protocol = 'oidc' | 'saml';
export interface AppConnector {
  id: string; name: string; description: string; logo?: string | null; protocol: Protocol; enabled: boolean; redirect_uris: string[];
  entity_id: string | null; acs_url: string | null; attribute_mapping: Record<string, string>; allowed_roles: string[]; secret_ref: string | null; launch_url: string | null;
  sp_certificate: string | null; want_signed_requests: boolean; nameid_format: 'emailAddress' | 'unspecified' | 'persistent' | null;
  scopes: string[]; allow_refresh_tokens: boolean;
}

/** Scopes an OIDC application may receive on top of openid, in display order. */
export const OIDC_SCOPES = ['profile', 'email', 'roles', 'offline_access'] as const;
export type OidcScope = (typeof OIDC_SCOPES)[number];
export type OidcScopeChecks = Record<OidcScope, boolean>;
export const scopeChecksFromList = (scopes: string[]): OidcScopeChecks => ({ profile: scopes.includes('profile'), email: scopes.includes('email'), roles: scopes.includes('roles'), offline_access: scopes.includes('offline_access') });
export const scopeListFromChecks = (c: OidcScopeChecks): string[] => OIDC_SCOPES.filter((sc) => c[sc]);

/** What the parse-sp-metadata endpoint returns (fields are null when absent from the document). */
export interface SpMetadataResult { entity_id: string | null; acs_url: string | null; sp_certificate: string | null; }
/** Form values from an SP metadata import: a field the document does not carry keeps what the form already holds. */
export function spMetadataFormValues(r: SpMetadataResult, current: { entity: string; acs: string; cert: string }) {
  return { entity: r.entity_id ?? current.entity, acs: r.acs_url ?? current.acs, cert: r.sp_certificate ?? current.cert };
}

/** "name=profileKey" lines <-> mapping object. */
export function parseMapping(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const t = line.trim(); if (!t) continue; const i = t.indexOf('='); out[(i < 0 ? t : t.slice(0, i)).trim()] = i < 0 ? '' : t.slice(i + 1).trim(); }
  return out;
}
export const formatMapping = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join('\n');
/** One value per line or comma separated, blanks dropped, duplicates removed. */
export const parseList = (text: string): string[] => [...new Set(text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

/** Applications plugin screen: the third-party applications that sign in through this platform (OIDC or SAML). Configuration only for now; saved on the working branch, live after Apply. No secret is entered here: only the name of a secret in the secret store. */
@Component({
  selector: 'app-applications', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Applications (plugin). Register the third-party applications that sign in through this platform, in OpenID Connect or SAML.</p>
  <p class="hint">OpenID Connect applications sign in through the OIDC provider plugin; SAML 2.0 applications sign in through the SAML IdP plugin. Secrets are never typed here, only the name of the secret in the secret store. An application is closed until you choose which roles may open it. Fictional demo only.</p>
  @if (note()) { <p role="status" class="msg" id="app-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="app-problem">{{problem()}}</p> }
  @if (off()) { <p class="hint" id="app-off">The Application connectors plugin is not enabled on this branch. Enable it in Plugins first.</p> } @else {
  <section class="card"><div class="scroll"><table id="app-table"><thead><tr><th>Application</th><th>Protocol</th><th>Roles allowed</th><th>Enabled</th><th></th></tr></thead><tbody>
  @for (a of apps(); track a.id) { <tr><td><b>{{a.name}}</b><br><small>{{a.id}}</small></td><td>{{a.protocol === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}}</td>
    <td>{{a.allowed_roles.length ? a.allowed_roles.join(', ') : 'nobody yet'}}</td><td>{{a.enabled ? 'yes' : 'no'}}</td>
    <td><button class="secondary" (click)="edit(a)">Edit</button><button class="secondary" (click)="toggle(a)" [disabled]="s.branch()==='main'">{{a.enabled ? 'Disable' : 'Enable'}}</button><button class="secondary" (click)="remove(a)" [disabled]="s.branch()==='main' || a.enabled">Delete</button></td></tr> }
  @empty { <tr><td colspan="5">No application yet.</td></tr> }</tbody></table></div>
  @if (s.branch()==='main') { <p class="hint">Choose a working branch (not main) to make changes.</p> }</section>
  <section class="card" id="app-form"><h3>{{editing() ? 'Edit ' + id : 'Add an application'}}</h3>
  <div class="row"><label>ID<input name="aid" [(ngModel)]="id" pattern="[a-z0-9-]{1,32}" [disabled]="editing()" /></label><label>Name<input name="aname" [(ngModel)]="name" maxlength="80" /></label>
  <label>Protocol<select name="aproto" [(ngModel)]="protocol"><option value="oidc">OpenID Connect</option><option value="saml">SAML 2.0</option></select></label></div>
  <div class="row"><label>Description<input name="adesc" [(ngModel)]="description" maxlength="240" /></label></div>
  <div class="panel app-logo-editor"><h4>Application logo</h4>
  <p class="hint">PNG, JPEG or WebP up to 64 KB, or SVG up to 50 KB. Stored in Dolt with the application, versioned on this branch and live after Apply.</p>
  @if (logo) { <img class="app-logo-preview" [src]="logo" alt="Application logo preview" /> }
  <label>Upload image<input type="file" name="alogo" accept="image/png,image/jpeg,image/webp,image/svg+xml" (change)="uploadLogo($event)" [disabled]="s.branch()==='main'" /></label>
  @if (logo) { <button class="secondary" (click)="logo=null" [disabled]="s.branch()==='main'">Remove logo</button> }
  </div>
  @if (protocol === 'oidc') { <div class="row"><label>Redirect URIs (one per line, exact, https)<textarea name="auris" rows="3" [(ngModel)]="uris"></textarea></label>
  <label>Launch URL (where users open the app; shown on their home page)<input name="alaunch" [(ngModel)]="launch" placeholder="https://app.example.com/" /></label></div>
  <div class="row"><div><small>Scopes the application may receive (openid is always granted)</small><br>
  <label class="row"><input type="checkbox" name="ascopeprofile" [(ngModel)]="scopeChecks.profile" /> profile</label>
  <label class="row"><input type="checkbox" name="ascopeemail" [(ngModel)]="scopeChecks.email" /> email</label>
  <label class="row"><input type="checkbox" name="ascoperoles" [(ngModel)]="scopeChecks.roles" /> roles</label>
  <label class="row"><input type="checkbox" name="ascopeoffline" [(ngModel)]="scopeChecks.offline_access" /> offline_access</label></div>
  <div><small>Tokens</small><br><label class="row"><input type="checkbox" name="arefresh" [(ngModel)]="allowRefresh" /> Allow refresh tokens (required for offline_access)</label></div></div> }
  @else {
  <div class="row"><label>SP entity ID<input name="aent" [(ngModel)]="entity" /></label><label>ACS URL (https)<input name="aacs" [(ngModel)]="acs" /></label>
  <label>NameID format<select name="anameid" [(ngModel)]="nameid"><option value="emailAddress">emailAddress</option><option value="unspecified">unspecified</option><option value="persistent">persistent</option></select></label></div>
  <div class="row"><label class="app-wide">SP signing certificate (PEM)<textarea name="acert" rows="4" [(ngModel)]="cert" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label></div>
  <div class="row"><label class="row"><input type="checkbox" name="asigned" [(ngModel)]="signedReq" /> Require signed AuthnRequests (needs the certificate above)</label></div>
  <div class="row"><label class="app-wide">Import SP metadata (paste the XML)<textarea name="aspmeta" rows="3" [(ngModel)]="spMeta"></textarea></label>
  <div><button class="secondary" id="app-spmeta-import" (click)="importSpMetadata()" [disabled]="!spMeta.trim()">Read metadata</button><br>
  <a class="hint" [href]="idpMetadataUrl()" target="_blank" rel="noopener">Download this platform's IdP metadata to register in the application</a></div></div> }
  <div class="row"><label>Attributes sent (name=profile key, one per line)<textarea name="amap" rows="3" [(ngModel)]="mapping"></textarea></label>
  <label>Roles allowed (comma or one per line)<textarea name="aroles" rows="3" [(ngModel)]="roles"></textarea></label></div>
  <div class="row"><label>Secret name in the secret store<input name="aref" [(ngModel)]="ref" placeholder="apps/my-app/client-secret" /></label></div>
  <button id="app-save" (click)="save()" [disabled]="s.branch()==='main'">{{editing() ? 'Save changes' : 'Add application'}}</button>
  @if (editing()) { <button class="secondary" (click)="reset()">Cancel</button> }</section> }`,
})
export class ApplicationsPage {
  protected readonly s = inject(Session);
  protected apps = signal<AppConnector[]>([]); protected note = signal(''); protected problem = signal(''); protected off = signal(false); protected editing = signal(false);
  protected id = ''; protected name = ''; protected description = ''; protected protocol: Protocol = 'oidc'; protected uris = ''; protected entity = ''; protected acs = ''; protected mapping = ''; protected roles = ''; protected ref = ''; protected launch = '';
  protected logo: string | null = null;
  protected async uploadLogo(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return;
    if (file.size > 65536 || !['image/png','image/jpeg','image/webp','image/svg+xml'].includes(file.type)) { this.problem.set('Choose a PNG, JPEG, WebP or SVG image under 64 KB.'); input.value = ''; return; }
    try { this.logo = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(Error('Could not read image')); r.readAsDataURL(file); }); this.problem.set(''); } catch (e) { this.problem.set((e as Error).message); } finally { input.value = ''; }
  }
  protected nameid = 'emailAddress'; protected cert = ''; protected signedReq = false; protected spMeta = '';
  protected scopeChecks: OidcScopeChecks = scopeChecksFromList(['profile', 'email', 'roles']); protected allowRefresh = false;
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  private fail(r: { status: number; data: any }) { if (r.status < 400) return false; this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return true; }
  protected async load() {
    try {
      const r = await this.s.api.raw<any>('GET', '/app-connectors', undefined, this.h());
      if (r.status === 404) { this.off.set(true); this.problem.set(''); return; }
      if (this.fail(r)) return; this.off.set(false); this.apps.set(r.data.apps); this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); }
  }
  private async run(method: string, path: string, body: object | undefined, ok: string) { const r = await this.s.api.raw<any>(method, path, body, this.h()); if (this.fail(r)) return false; this.note.set(ok + ' Saved on the working branch; live after Apply.'); this.problem.set(''); await this.load(); return true; }
  protected edit(a: AppConnector) {
    this.logo = a.logo ?? null; this.editing.set(true); this.id = a.id; this.name = a.name; this.description = a.description; this.protocol = a.protocol; this.uris = a.redirect_uris.join('\n');
    this.entity = a.entity_id ?? ''; this.acs = a.acs_url ?? ''; this.mapping = formatMapping(a.attribute_mapping); this.roles = a.allowed_roles.join('\n'); this.ref = a.secret_ref ?? ''; this.launch = a.launch_url ?? '';
    this.nameid = a.nameid_format ?? 'emailAddress'; this.cert = a.sp_certificate ?? ''; this.signedReq = a.want_signed_requests; this.spMeta = '';
    this.scopeChecks = scopeChecksFromList(a.scopes ?? []); this.allowRefresh = a.allow_refresh_tokens;
  }
  protected reset() { this.logo = null; this.editing.set(false); this.id = this.name = this.description = this.uris = this.entity = this.acs = this.mapping = this.roles = this.ref = this.launch = ''; this.protocol = 'oidc'; this.nameid = 'emailAddress'; this.cert = ''; this.signedReq = false; this.spMeta = ''; this.scopeChecks = scopeChecksFromList(['profile', 'email', 'roles']); this.allowRefresh = false; }
  private body(): Record<string, unknown> {
    return { logo: this.logo, name: this.name, description: this.description, protocol: this.protocol, redirect_uris: this.protocol === 'oidc' ? parseList(this.uris) : [], entity_id: this.protocol === 'saml' ? this.entity : null, acs_url: this.protocol === 'saml' ? this.acs : null, attribute_mapping: parseMapping(this.mapping), allowed_roles: parseList(this.roles), secret_ref: this.ref || null, launch_url: this.protocol === 'oidc' ? this.launch || null : null,
      nameid_format: this.protocol === 'saml' ? this.nameid : null, sp_certificate: this.protocol === 'saml' ? this.cert.trim() || null : null, want_signed_requests: this.protocol === 'saml' ? this.signedReq : false,
      scopes: this.protocol === 'oidc' ? scopeListFromChecks(this.scopeChecks) : [], allow_refresh_tokens: this.protocol === 'oidc' ? this.allowRefresh : false };
  }
  /** IdP metadata to hand to the SAML application when it is registered there. */
  protected idpMetadataUrl(): string { return `/api/sso/${encodeURIComponent(this.s.api.tenant)}/saml/metadata`; }
  /** Fill entity id, ACS URL and certificate from a pasted SP metadata document (fields it lacks are kept). */
  protected async importSpMetadata() {
    const r = await this.s.api.raw<SpMetadataResult>('POST', '/app-connectors/parse-sp-metadata', { metadata: this.spMeta }, this.h());
    if (this.fail(r)) return;
    const v = spMetadataFormValues(r.data, { entity: this.entity, acs: this.acs, cert: this.cert });
    this.entity = v.entity; this.acs = v.acs; this.cert = v.cert;
    this.note.set('Metadata read: entity ID, ACS URL and certificate filled where the document carries them.'); this.problem.set('');
  }
  protected async save() {
    const ok = this.editing() ? await this.run('PATCH', `/app-connectors/${encodeURIComponent(this.id)}`, this.body(), 'Application saved.') : await this.run('POST', '/app-connectors', { id: this.id, ...this.body() }, 'Application added.');
    if (ok) this.reset();
  }
  protected toggle(a: AppConnector) { void this.run('PATCH', `/app-connectors/${encodeURIComponent(a.id)}`, { enabled: !a.enabled }, a.enabled ? 'Application disabled.' : 'Application enabled.'); }
  protected remove(a: AppConnector) { void this.run('DELETE', `/app-connectors/${encodeURIComponent(a.id)}`, undefined, 'Application deleted.'); }
}
