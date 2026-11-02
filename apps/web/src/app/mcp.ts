import { DatePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

interface McpSession { id: string; owner: string; label: string; branch: string; createdAt: string; expiresAt: string; revoked: boolean; submitted: boolean; calls: number }
interface Activity { id: number; at: string; tool: string; kind: string; detail: string; targets: string[]; allow: boolean; reasons: string[]; rowCount: number | null; error: string | null }

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
  protected activity = signal<Activity[]>([]);
  protected activityFor = signal('');
  protected created = signal<(McpSession & { secret: string }) | null>(null);
  protected note = signal(''); protected problem = signal('');
  protected label = ''; protected ttlHours: number = 8;
  constructor() { effect(() => { this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected expired(x: McpSession) { return new Date(x.expiresAt).getTime() <= Date.now(); }
  protected configFor(c: McpSession & { secret: string }) {
    return JSON.stringify({ mcpServers: { 'iam-poc': { url: `${location.origin.replace(/:\\d+$/, '')}/tenants/acme-demo/mcp`.replace('http://localhost', 'http://localhost:3000'), headers: { Authorization: `Bearer ${c.secret}` } } } }, null, 2);
  }
  private async call(method: string, path: string, body?: object): Promise<Record<string, any> | null> {
    try {
      const r = await this.s.api.raw<any>(method, path, body ?? (method === 'GET' ? undefined : {}), this.h());
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data?.message) ? r.data.message.join(' ') : r.data?.message ?? 'Refused'); return null; }
      this.problem.set(''); return r.data ?? {};
    } catch (e) { this.problem.set((e as Error).message); return null; }
  }
  protected async load() { const r = await this.call('GET', '/mcp-sessions'); if (r) this.sessions.set(r['sessions'] ?? []); }
  protected async create() {
    const r = await this.call('POST', '/mcp-sessions', { label: this.label, ttl_seconds: Math.round(this.ttlHours * 3600) });
    if (r) { this.created.set(r as McpSession & { secret: string }); this.note.set('Session created.'); await this.load(); }
  }
  protected async revoke(x: McpSession) { if (!confirm(`Revoke session ${x.id} (${x.label})? The AI loses access immediately.`)) return; const r = await this.call('DELETE', `/mcp-sessions/${encodeURIComponent(x.id)}`); if (r) { this.note.set('Session revoked.'); await this.load(); } }
  protected async showActivity(id: string) { const r = await this.call('GET', `/mcp-sessions/${encodeURIComponent(id)}/activity?limit=200`); if (r) { this.activity.set(r['entries'] ?? []); this.activityFor.set(id); } }
}
