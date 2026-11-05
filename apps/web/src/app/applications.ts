import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export type Protocol = 'oidc' | 'saml';
export interface AppConnector {
  id: string; name: string; description: string; protocol: Protocol; enabled: boolean; redirect_uris: string[];
  entity_id: string | null; acs_url: string | null; attribute_mapping: Record<string, string>; allowed_roles: string[]; secret_ref: string | null;
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
  <p class="hint">OpenID Connect applications sign in through the OIDC provider plugin; SAML arrives in the next step. Secrets are never typed here, only the name of the secret in the secret store. An application is closed until you choose which roles may open it. Fictional demo only.</p>
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
  @if (protocol === 'oidc') { <div class="row"><label>Redirect URIs (one per line, exact, https)<textarea name="auris" rows="3" [(ngModel)]="uris"></textarea></label></div> }
  @else { <div class="row"><label>SP entity ID<input name="aent" [(ngModel)]="entity" /></label><label>ACS URL (https)<input name="aacs" [(ngModel)]="acs" /></label></div> }
  <div class="row"><label>Attributes sent (name=profile key, one per line)<textarea name="amap" rows="3" [(ngModel)]="mapping"></textarea></label>
  <label>Roles allowed (comma or one per line)<textarea name="aroles" rows="3" [(ngModel)]="roles"></textarea></label></div>
  <div class="row"><label>Secret name in the secret store<input name="aref" [(ngModel)]="ref" placeholder="apps/my-app/client-secret" /></label></div>
  <button id="app-save" (click)="save()" [disabled]="s.branch()==='main'">{{editing() ? 'Save changes' : 'Add application'}}</button>
  @if (editing()) { <button class="secondary" (click)="reset()">Cancel</button> }</section> }`,
})
export class ApplicationsPage {
  protected readonly s = inject(Session);
  protected apps = signal<AppConnector[]>([]); protected note = signal(''); protected problem = signal(''); protected off = signal(false); protected editing = signal(false);
  protected id = ''; protected name = ''; protected description = ''; protected protocol: Protocol = 'oidc'; protected uris = ''; protected entity = ''; protected acs = ''; protected mapping = ''; protected roles = ''; protected ref = '';
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
    this.editing.set(true); this.id = a.id; this.name = a.name; this.description = a.description; this.protocol = a.protocol; this.uris = a.redirect_uris.join('\n');
    this.entity = a.entity_id ?? ''; this.acs = a.acs_url ?? ''; this.mapping = formatMapping(a.attribute_mapping); this.roles = a.allowed_roles.join('\n'); this.ref = a.secret_ref ?? '';
  }
  protected reset() { this.editing.set(false); this.id = this.name = this.description = this.uris = this.entity = this.acs = this.mapping = this.roles = this.ref = ''; this.protocol = 'oidc'; }
  private body(): Record<string, unknown> {
    return { name: this.name, description: this.description, protocol: this.protocol, redirect_uris: this.protocol === 'oidc' ? parseList(this.uris) : [], entity_id: this.protocol === 'saml' ? this.entity : null, acs_url: this.protocol === 'saml' ? this.acs : null, attribute_mapping: parseMapping(this.mapping), allowed_roles: parseList(this.roles), secret_ref: this.ref || null };
  }
  protected async save() {
    const ok = this.editing() ? await this.run('PATCH', `/app-connectors/${encodeURIComponent(this.id)}`, this.body(), 'Application saved.') : await this.run('POST', '/app-connectors', { id: this.id, ...this.body() }, 'Application added.');
    if (ok) this.reset();
  }
  protected toggle(a: AppConnector) { void this.run('PATCH', `/app-connectors/${encodeURIComponent(a.id)}`, { enabled: !a.enabled }, a.enabled ? 'Application disabled.' : 'Application enabled.'); }
  protected remove(a: AppConnector) { void this.run('DELETE', `/app-connectors/${encodeURIComponent(a.id)}`, undefined, 'Application deleted.'); }
}
