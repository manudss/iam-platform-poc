import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Session } from '../session';
import { ConnectionInput, ConnectionProvider, ConnectionProbe, WorkflowConnection, clientOf } from './wf-model';

export function visibleConnections(rows: WorkflowConnection[], query: string) {
  const q = query.trim().toLowerCase();
  return rows.filter(c => !q || `${c.name} ${c.provider}`.toLowerCase().includes(q));
}
/** A probe is valid for the exact metadata revision and branch that was checked, never forever. */
export function probeFor(c: WorkflowConnection, probes: Record<string, ConnectionProbe>) {
  const p = probes[c.id]; return p?.revision === c.revision ? p : null;
}
@Component({selector: 'app-workflow-connections', imports: [FormsModule, RouterLink], styleUrl: '../pages.css', styles: [`
.wfc-tabs { display:flex; gap:1.5rem; border-bottom:1px solid var(--line); padding:.7rem 0; margin-bottom:1.4rem; }
.wfc-tabs a { color:var(--muted); text-decoration:none; padding:.3rem 0; }
.wfc-tabs a.current { color:var(--accent); border-bottom:2px solid var(--accent); font-weight:600; }
.wfc-head { display:flex; align-items:center; gap:1rem; justify-content:space-between; flex-wrap:wrap; }
.wfc-head h2 { margin:0 0 .3rem; }
.wfc-search { width:min(100%,560px); margin:1.4rem 0 .2rem; }
.wfc-list { max-width:900px; }
.wfc-item { padding:1.2rem 0; border-bottom:1px solid var(--line); }
.wfc-title { display:flex; gap:.8rem; align-items:center; }
.wfc-title h3 { margin:0 0 .3rem; font-size:1rem; }
.wfc-icon { display:grid; place-items:center; background:var(--accent-soft); color:var(--accent); border-radius:.5rem; width:42px; height:42px; flex-shrink:0; font-size:1.2rem; }
.wfc-grow { flex:1; min-width:0; overflow-wrap:anywhere; }
.wfc-actions { display:flex; gap:.5rem; flex-wrap:wrap; }
.wfc-info { max-width:900px; margin-top:1.4rem; padding:1rem; border:1px solid var(--line); background:var(--panel); border-radius:var(--radius); }
.wfc-info p { margin-bottom:0; }
.wfc-status { border-radius:1rem; padding:.3rem .6rem; font-size:.75rem; background:var(--warn-soft); color:var(--ink); white-space:nowrap; }
.wfc-status.ok { background:var(--ok-soft); color:var(--ok); }
@media(max-width:480px) { .wfc-tabs {gap:1rem;} .wfc-status {font-size:.7rem;} .wfc-title {gap:.5rem;} }
.wfc-dialog {width:min(580px,calc(100% - 2rem));max-height:90dvh;overflow:auto;color:var(--ink);box-sizing:border-box;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:1.4rem;box-shadow:0 15px 45px var(--shadow-color);}
.wfc-dialog::backdrop {background:var(--scrim);}
.wfc-dialog label {display:flex;flex-direction:column;gap:.4rem;margin:1rem 0;}
.wfc-dialog input,.wfc-dialog select,.wfc-dialog textarea {width:100%;box-sizing:border-box;}
.wfc-dialog textarea {min-height:7rem;resize:vertical;}
.wfc-dialog .wfc-actions {position:sticky;bottom:-1.4rem;background:var(--card);padding:.8rem 0;margin-bottom:-.4rem;border-top:1px solid var(--line);z-index:1;}
.wfc-dialog fieldset {min-width:0;}
`], template: `
<nav class="wfc-tabs" aria-label="Workflows"><a routerLink="/workflows">Workflows</a><a routerLink="/workflows/runs">Executions</a><a class="current" routerLink="/workflows/connections" aria-current="page">Connections</a></nav>
<div class="wfc-head"><div><h2>Connections</h2><span class="hint">Reusable credentials, never in workflows</span></div><button (click)="configure(null)" [disabled]="busy()">+ New connection</button></div>
@if (note()) {<p class="msg" role="status">{{note()}}</p>}
@if (loading()) {<p class="hint" role="status">Loading connections...</p>}
<input class="wfc-search" type="search" name="connectionSearch" [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Search connections..." aria-label="Search connections" />
<div class="wfc-list">
@for (c of visible(); track c.id) {
  <section class="wfc-item"><div class="wfc-title"><span class="wfc-icon" aria-hidden="true">{{icon(c)}}</span><div class="wfc-grow"><h3>{{c.name}}</h3><span class="hint">{{provider(c)}}</span></div><span class="wfc-status" [class.ok]="status(c) === 'Verified'">{{status(c)}}</span></div>
  <p class="hint">{{c.secretConfigured ? 'Credential stored by reference' : c.provider === 'http' ? 'HTTPS destination · no bearer token' : 'No credential stored'}}</p>
  <div class="wfc-actions"><button class="secondary" (click)="configure(c)" [disabled]="busy()">Configure</button><button class="secondary" (click)="test(c)" [disabled]="busy() || (!c.secretConfigured && c.provider !== 'http')">{{testing() === c.id ? 'Checking...' : 'Test read-only'}}</button></div>
  @if (probe(c); as p) {<p class="hint">{{p.checkedAt}} · {{p.message || 'Read-only access check passed for this revision. This does not guarantee an action will succeed.'}}</p>}
  </section>
} @empty { @if (!loading()) {<p class="hint">{{query() ? 'No connection matches your search.' : 'No connections yet. Add Google Sheets, Jira or HTTP to get started.'}}</p>} }
</div>
<p class="hint">A connection test reads service access only. It does not create a ticket, append a row or send a workflow action.</p>
<div class="wfc-info"><b>Write-only credentials</b><p class="hint">Secret revisions live in OpenBao. Dolt versions connection metadata and references, never credentials. Without a secret store, credential storage and authenticated live use are blocked.</p>@if (!secretStoreConfigured()) {<p class="hint">OpenBao is not configured. Ask your operator to connect the secret store.</p>}</div>
@if(formOpen()) {
<dialog #connectionDialog class="wfc-dialog" aria-labelledby="connection-form-title" (keydown)="trapFocus($event)" (cancel)="$event.preventDefault(); !busy() && closeForm()">
<h2 id="connection-form-title">{{editing() ? 'Configure ' + editing()!.name : 'New connection'}}</h2><p class="hint">Save on your working branch, then review and Apply.</p>
<fieldset [disabled]="busy()" style="border:0;padding:0;margin:0">
<label>Name<input autofocus name="connectionName" [(ngModel)]="formName" (ngModelChange)="changed()" maxlength="80" /></label>
<label>Provider<select name="connectionProvider" [(ngModel)]="formProvider" (ngModelChange)="providerChanged()" [disabled]="!!editing()"><option value="jira">Jira</option><option value="google-sheets">Google Sheets</option><option value="http">HTTP</option></select></label>
@for(f of fields();track f.key) {<label>{{f.label}}<input [name]="'connection-' + f.key" [(ngModel)]="formConfig[f.key]" (ngModelChange)="changed()" [placeholder]="f.placeholder" maxlength="300" /></label>}
<label>{{editing() ? 'Replace ' : ''}}{{secretLabel()}}
@if(formProvider === 'google-sheets') {<textarea name="connectionSecret" [(ngModel)]="formSecret" (ngModelChange)="changed()" autocomplete="off" spellcheck="false" maxlength="20000" placeholder="Paste service account JSON"></textarea>}
@else {<input type="password" name="connectionSecret" [(ngModel)]="formSecret" (ngModelChange)="changed()" autocomplete="new-password" maxlength="20000" placeholder="Enter a new credential" />}
</label>
<p class="hint">Write-only. Its value is never returned. {{editing()?.secretConfigured ? 'Leave blank to keep the current credential revision.' : 'No credential stored yet.'}} No plaintext fallback if OpenBao is unavailable.</p>
@if(formResult();as r) {<div class="wfc-info" role="status"><b>{{r.status}}</b><p class="hint">{{r.message || 'Read-only access check passed. No workflow action ran and these fields have not been saved.'}} · {{r.checkedAt}}</p></div>}
@if(formError()) {<p role="alert" class="msg">{{formError()}}</p>}
<p class="hint">Test uses the current fields without saving them. Changing a field clears the result. No automatic test on Save.</p>
<div class="wfc-actions"><button class="secondary" (click)="closeForm()">Cancel</button><button class="secondary" (click)="testForm()" [disabled]="!formName.trim()">Test read-only</button><button (click)="saveForm()" [disabled]="!formName.trim()">Save connection</button></div>
</fieldset>@if(busy()) {<p role="status" class="hint">Working...</p>}
</dialog>
}
`})
export class WorkflowConnectionsPage  {
  protected readonly s = inject(Session);
  protected rows = signal<WorkflowConnection[]>([]);
  protected query = signal(''); protected note = signal(''); protected busy = signal(false); protected loading = signal(true);
  protected testing = signal(''); protected secretStoreConfigured = signal(false);
  protected probes = signal<Record<string, ConnectionProbe>>({});
  protected visible = computed(() => visibleConnections(this.rows(), this.query()));
  private epoch = 0;
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('connectionDialog');
  constructor() { effect(() => { this.s.branchEpoch(); this.closeForm(); this.probes.set({}); void this.load(); }); effect(() => { const dialog=this.dialog()?.nativeElement; if(dialog && !dialog.open) dialog.showModal(); }); }
  protected async load() {
    const epoch = ++this.epoch; this.loading.set(true); this.rows.set([]); this.note.set('');
    try { const r = await clientOf(this.s).connections(); if (epoch !== this.epoch) return; this.rows.set(r.connections); this.secretStoreConfigured.set(r.secretStoreConfigured); }
    catch { if (epoch === this.epoch) this.note.set('Connections could not be loaded. Check your access and try again.'); }
    finally { if (epoch === this.epoch) this.loading.set(false); }
  }
  protected probe(c: WorkflowConnection) { return probeFor(c, this.probes()); }
  protected status(c: WorkflowConnection) { return this.probe(c)?.status ?? c.status; }
  protected provider(c: WorkflowConnection) { return c.provider === 'google-sheets' ? 'Google Sheets' : c.provider === 'jira' ? 'Jira' : 'HTTP'; }
  protected icon(c: WorkflowConnection) { return c.provider === 'google-sheets' ? '▦' : c.provider === 'jira' ? 'J' : '↗'; }
  protected editing = signal<WorkflowConnection | null>(null); protected formOpen = signal(false);
  protected formName = ''; protected formProvider: ConnectionProvider = 'jira'; protected formConfig: Record<string,string> = {}; protected formSecret = '';
  protected formError = signal('');
  protected formResult = signal<{status: string; checkedAt: string; message?: string} | null>(null);
  private formVersion = 0;
  protected fields() { return this.formProvider === 'jira' ? [{key:'instanceUrl',label:'Jira site URL',placeholder:'https://team.atlassian.net'},{key:'email',label:'Account email',placeholder:'support@example.invalid'}] : this.formProvider === 'http' ? [{key:'baseUrl',label:'HTTPS base URL',placeholder:'https://api.example.com/v1/'}] : [{key:'spreadsheetId',label:'Spreadsheet ID (for read-only test)',placeholder:''},{key:'sheetId',label:'Sheet ID',placeholder:'0'},{key:'userEmail',label:'Delegated user email (optional)',placeholder:''}]; }
  protected secretLabel() { return this.formProvider === 'jira' ? 'API token' : this.formProvider === 'google-sheets' ? 'Service account JSON' : 'Bearer token (optional)'; }
  protected trapFocus(event: KeyboardEvent) {
    if(event.key !== 'Tab') return;
    const dialog=this.dialog()?.nativeElement;if(!dialog)return;
    const fields=Array.from(dialog.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)')).filter(e=>e.getClientRects().length>0);
    const first=fields[0],last=fields.at(-1);if(!first){event.preventDefault();return;}
    if(event.shiftKey && (dialog.ownerDocument.activeElement===first || dialog.ownerDocument.activeElement===dialog)){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && dialog.ownerDocument.activeElement===last){event.preventDefault();first.focus();}
  }
  protected changed() { this.formError.set(''); this.formVersion++; this.formResult.set(null); }
  protected providerChanged() { this.formConfig = {}; this.formSecret = ''; this.changed(); }
  protected configure(c: WorkflowConnection | null) { this.editing.set(c); this.formName=c?.name ?? ''; this.formProvider=c?.provider ?? 'jira'; this.formConfig={...c?.config}; this.formSecret=''; this.formResult.set(null); this.formVersion++; this.formOpen.set(true); }
  protected closeForm() { this.formSecret=''; this.formConfig={}; this.formResult.set(null); this.formOpen.set(false); this.formError.set(''); this.editing.set(null); this.formVersion++; }
  protected formBody(): ConnectionInput { return {name:this.formName.trim(),provider:this.formProvider,config:{...this.formConfig},...(this.formSecret ? {secret:this.formSecret} : {})}; }
  protected async saveForm() {
    const epoch=this.epoch, version=this.formVersion; this.busy.set(true);
    try { await clientOf(this.s).saveConnection(this.formBody(),this.editing()?.id); if(epoch===this.epoch && version===this.formVersion) {this.closeForm(); await this.load();this.note.set('Connection saved on this working branch. Review and Apply before live workflows use it.');} }
    catch {if(epoch===this.epoch)this.formError.set('Connection could not be saved. Check fields, working branch and secret store configuration.');}
    finally {this.busy.set(false);}
  }
  protected async testForm() {
    const epoch=this.epoch,version=this.formVersion;this.busy.set(true);this.formResult.set(null);
    try { const p=await clientOf(this.s).probeConnection({...this.formBody(),...(this.editing() ? {existingId:this.editing()!.id} : {})});if(epoch===this.epoch && version===this.formVersion && p.readOnly)this.formResult.set(p); }
    catch {if(epoch===this.epoch && version===this.formVersion)this.formResult.set({status:'Failed',checkedAt:new Date().toISOString(),message:'Read-only check could not run. Check the configuration and your access.'});}
    finally {this.busy.set(false);}
  }
  protected async test(c: WorkflowConnection) {
    const epoch = this.epoch; this.busy.set(true); this.testing.set(c.id);
    try { const p = await clientOf(this.s).testConnection(c.id); if (epoch === this.epoch && p.readOnly) this.probes.update(all => ({...all, [c.id]: p})); }
    catch { if (epoch === this.epoch) this.note.set('Read-only check could not run. Check the configuration and your access.'); }
    finally { this.busy.set(false); this.testing.set(''); }
  }
}
