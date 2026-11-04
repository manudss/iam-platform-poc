import { DatePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

interface McpSession { id: string; owner: string; label: string; branch: string; createdAt: string; expiresAt: string; revoked: boolean; submitted: boolean; calls: number }
interface Activity { id: number; at: string; tool: string; kind: string; detail: string; targets: string[]; allow: boolean; reasons: string[]; rowCount: number | null; error: string | null }
interface Upstream { id: string; name: string; url: string; enabled: boolean; lastStatus: string; lastTools: number | null }

/**
 * MCP sessions: give an AI assistant branch-confined access to the platform. The session secret is shown ONCE
 * here; only its hash is stored. The AI works on its own Dolt branch and can only open a pull request for a
 * human to review - it can never approve, merge, apply, or pick an existing branch.
 */
@Component({
  selector: 'app-mcp', imports: [FormsModule, DatePipe], styleUrl: './pages.css',
  template: `
  <p class="lead">AI access through the Model Context Protocol. A session gives an AI client (Claude, ChatGPT, VS Code…) read access to the data and the ability to prepare changes on its own data branch. Publishing stays human: the AI can only open a pull request.</p>
  <p class="hint">The secret is displayed once, at creation. Sessions expire (max 7 days) and can be revoked at any time. Every tool call and every table the AI reads or writes is traced below.</p>
  @if (note()) { <p role="status" class="msg" id="mcp-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="mcp-problem">{{problem()}}</p> }

  <section class="card"><h3>New session</h3>
    <div class="row"><label>Label<input name="mcplabel" [(ngModel)]="label" maxlength="120" placeholder="e.g. Claude demo" /></label>
    <label>Lifetime (hours)<input name="mcpttl" type="number" [(ngModel)]="ttlHours" min="0.02" max="168" /></label>
    <button id="mcp-create" (click)="create()" [disabled]="!label.trim()">Create session</button></div>
    @if (created(); as c) {
      <div class="card" id="mcp-secret-box"><h3>Session {{c.id}} - secret shown once</h3>
        <p class="hint">Copy it now: only its hash is stored, it can never be displayed again. Branch <b>{{c.branch}}</b> was cut from main.</p>
        <label>Secret<input readonly name="mcpsecret" [value]="c.secret" (click)="$any($event.target).select()" /></label>
        <label>Client configuration<textarea readonly name="mcpconfig" rows="7" (click)="$any($event.target).select()">{{configFor(c)}}</textarea></label>
      </div> }
  </section>

  <section class="card" id="mcp-upstreams"><h3>External MCP servers (gateway)</h3>
    <p class="hint">An external MCP server (e.g. Jira) registered here is relayed to every AI session: its tools appear as <b>name__tool</b>. The token authenticates the platform towards that server: it is stored encrypted, never displayed again, never sent to the AI, and every relayed call is traced below (kind <b>proxy</b>). Remote servers require https; http is accepted only for a local server (127.0.0.1).</p>
    <div class="row"><label>Name<input name="upname" [(ngModel)]="upName" maxlength="32" placeholder="e.g. jira" /></label>
    <label>URL<input name="upurl" [(ngModel)]="upUrl" placeholder="https://mcp.atlassian.net/v1/sse" size="34" /></label>
    <label>Token<input name="uptoken" type="password" [(ngModel)]="upToken" placeholder="stored encrypted, shown never" size="24" /></label>
    <button id="up-create" (click)="createUpstream()" [disabled]="!upName.trim() || !upUrl.trim() || !upToken.trim()">Register</button></div>
    <div class="scroll"><table id="up-table"><thead><tr><th>Name</th><th>URL</th><th>State</th><th>Last check</th><th>Tools</th><th></th></tr></thead><tbody>
    @for (u of upstreams(); track u.id) { <tr><td>{{u.name}}</td><td>{{u.url}}</td><td>{{u.enabled ? 'enabled' : 'disabled'}}</td><td>{{u.lastStatus}}</td><td>{{u.lastTools ?? ''}}</td>
      <td><button class="secondary" (click)="testUpstream(u)">Test</button><button class="secondary" (click)="removeUpstream(u)">Delete</button></td></tr> }
    @empty { <tr><td colspan="6">No external MCP server registered.</td></tr> }</tbody></table></div>
    @if (upTest(); as t) { <p class="hint" id="up-test-result">{{t}}</p> }
  </section>

  <section class="card"><h3>Sessions</h3><div class="scroll"><table id="mcp-table"><thead><tr><th>Session</th><th>Label</th><th>Owner</th><th>Branch</th><th>Expires</th><th>Calls</th><th>State</th><th></th></tr></thead><tbody>
    @for (x of sessions(); track x.id) { <tr><td>{{x.id}}</td><td>{{x.label}}</td><td>{{x.owner}}</td><td>{{x.branch}}</td><td>{{x.expiresAt | date:'short'}}</td><td>{{x.calls}}</td>
      <td>{{x.revoked ? 'revoked' : (expired(x) ? 'expired' : (x.submitted ? 'PR submitted' : 'active'))}}</td>
      <td><button class="secondary" (click)="showActivity(x.id)">Trace</button><button class="secondary" (click)="revoke(x)" [disabled]="x.revoked || expired(x)">Revoke</button></td></tr> }
    @empty { <tr><td colspan="8">No session yet.</td></tr> }</tbody></table></div>
  </section>

  @if (activityFor()) { <section class="card" id="mcp-activity"><h3>Trace of {{activityFor()}} <button class="secondary" (click)="activityFor.set('')">Close</button></h3>
    <div class="scroll"><table><thead><tr><th>Time</th><th>Tool</th><th>Kind</th><th>Targets</th><th>Decision</th><th>Rows</th><th>Detail</th></tr></thead><tbody>
    @for (a of activity(); track a.id) { <tr [class.bad]="!a.allow"><td>{{a.at | date:'HH:mm:ss'}}</td><td>{{a.tool}}</td><td>{{a.kind}}</td><td>{{a.targets.join(', ')}}</td>
      <td>{{a.allow ? 'allowed' : 'DENIED'}}</td><td>{{a.rowCount ?? ''}}</td><td>{{a.error ?? a.detail}}</td></tr> }
    @empty { <tr><td colspan="7">No call traced yet.</td></tr> }</tbody></table></div></section> }`,
})
export class McpPage {
  protected readonly s = inject(Session);
  protected sessions = signal<McpSession[]>([]);
  protected upstreams = signal<Upstream[]>([]);
  protected upName = ''; protected upUrl = ''; protected upToken = ''; protected upTest = signal('');
  protected activity = signal<Activity[]>([]);
  protected activityFor = signal('');
  protected created = signal<(McpSession & { secret: string }) | null>(null);
  protected note = signal(''); protected problem = signal('');
  protected label = ''; protected ttlHours: number = 8;
  constructor() { effect(() => { this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected expired(x: McpSession) { return new Date(x.expiresAt).getTime() <= Date.now(); }
  protected configFor(c: McpSession & { secret: string }) {
    // Local dev (ng serve on :4200) hits the API directly; everywhere else the console origin proxies /api to it.
    const base = location.port === '4200' ? 'http://localhost:3000' : location.origin + '/api';
    return JSON.stringify({ mcpServers: { 'iam-poc': { url: `${base}/tenants/acme-demo/mcp`, headers: { Authorization: `Bearer ${c.secret}` } } } }, null, 2);
  }
  private async call(method: string, path: string, body?: object): Promise<Record<string, any> | null> {
    try {
      const r = await this.s.api.raw<any>(method, path, body ?? (method === 'GET' ? undefined : {}), this.h());
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data?.message) ? r.data.message.join(' ') : r.data?.message ?? 'Refused'); return null; }
      this.problem.set(''); return r.data ?? {};
    } catch (e) { this.problem.set((e as Error).message); return null; }
  }
  protected async load() {
    const r = await this.call('GET', '/mcp-sessions'); if (r) this.sessions.set(r['sessions'] ?? []);
    const u = await this.call('GET', '/mcp-upstreams'); if (u) this.upstreams.set(u['upstreams'] ?? []);
  }
  protected async createUpstream() {
    const r = await this.call('POST', '/mcp-upstreams', { name: this.upName.trim(), url: this.upUrl.trim(), token: this.upToken });
    if (r) { this.upName = ''; this.upUrl = ''; this.upToken = ''; this.note.set('External MCP server registered: its tools are relayed to AI sessions.'); await this.load(); }
  }
  protected async testUpstream(u: Upstream) {
    this.upTest.set(`Testing ${u.name}…`);
    const r = await this.call('POST', `/mcp-upstreams/${encodeURIComponent(u.id)}/test`, {});
    if (r) this.upTest.set(r['ok'] ? `${u.name}: ${ (r['tools'] ?? []).length } tools reachable (${(r['tools'] ?? []).join(', ')})` : `${u.name}: ${r['error'] ?? 'unreachable'}`);
    await this.load();
  }
  protected async removeUpstream(u: Upstream) { if (!confirm(`Delete upstream ${u.name}? Its tools disappear from AI sessions immediately.`)) return; const r = await this.call('DELETE', `/mcp-upstreams/${encodeURIComponent(u.id)}`); if (r) { this.note.set('Upstream deleted.'); await this.load(); } }
  protected async create() {
    const r = await this.call('POST', '/mcp-sessions', { label: this.label, ttl_seconds: Math.round(this.ttlHours * 3600) });
    if (r) { this.created.set(r as McpSession & { secret: string }); this.note.set('Session created.'); await this.load(); }
  }
  protected async revoke(x: McpSession) { if (!confirm(`Revoke session ${x.id} (${x.label})? The AI loses access immediately.`)) return; const r = await this.call('DELETE', `/mcp-sessions/${encodeURIComponent(x.id)}`); if (r) { this.note.set('Session revoked.'); await this.load(); } }
  protected async showActivity(id: string) { const r = await this.call('GET', `/mcp-sessions/${encodeURIComponent(id)}/activity?limit=200`); if (r) { this.activity.set(r['entries'] ?? []); this.activityFor.set(id); } }
}
