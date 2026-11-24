import { RevealPassword } from './reveal-password';
import { Brand, Branding } from './branding';
import { afterNextRender, Component, inject, Injector, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeSwitch } from './theme-switch';

interface F { key: string; label: string; type: string; help?: string; options?: { value: string; label: string }[]; required: boolean; section?: string }
interface Issue { label?: string; id?: string; text: string }
/** Core fields the server can name in a validation message: banner anchor + inline error. */
const CORE: Record<string, [string, string]> = { id: ['User ID', 'su-id'], display_name: ['Display name', 'su-dn'], email: ['E-mail', 'su-em'], password: ['Password', 'su-pw'] };

/** Public account-request form on its own /signup page (no sign-in). Closed unless an administrator opened and applied it. It only sends a request. */
@Component({
  selector: 'app-signup', imports: [FormsModule, NgTemplateOutlet, ThemeSwitch, Brand, RevealPassword], styleUrl: './login.css',
  template: `
  <div class="auth-bg" aria-hidden="true"><img src="https://picsum.photos/1920/1080" alt="" loading="eager"></div>
  <div class="auth-veil" aria-hidden="true"></div>
  <app-theme-switch class="auth-theme" />
  <main class="login"><section class="card hero signup-card">
    <p style="margin:0"><a class="back" [href]="loginUrl()">&lsaquo; Back to sign in</a></p>
    <div class="brand"><div class="brand-title"><app-brand /></div></div>
    <h1 class="page-title">{{test() ? 'Create a test account' : 'Create an account'}}</h1>
    <ng-container *ngTemplateOutlet="body" />
    <p class="foot">Fictional demo data only. Do not enter real data. <a href="/privacy">Politique de confidentialité / Privacy</a> · <a href="/about">About this demo</a></p>
  </section></main>
  <ng-template #body>
  @if (state()==='loading') { <p>Loading...</p> }
  @else if (state()==='closed') { <p id="su-closed" role="status">Sign-up is closed.</p> }
  @else if (state()==='sent' && test()) { <p id="su-test-done" role="status">{{msg()}}</p><p><a class="create" id="su-test-signin" [href]="loginUrl()">Sign in with this test account</a></p> }
  @else if (state()==='sent') { <p id="su-sent" role="status">{{msg()}}</p>
    <form (ngSubmit)="confirm()"><fieldset class="su-fields" [disabled]="busyConfirm()"><label><span>Confirmation code</span><input name="code" [(ngModel)]="code" autocomplete="off" /></label></fieldset>
      <button id="su-confirm" [disabled]="busyConfirm()" [attr.aria-busy]="busyConfirm() || null">@if (busyConfirm()) {<span class="spin" aria-hidden="true"></span>Confirming…} @else {Confirm}</button></form>
    @if (confirmed()) { <p role="status">{{confirmed()}}</p> } }
  @else { @if (test(); as t) { <p class="hint" id="su-test-note">Test account on the branch <b>{{t.branch}}</b> only: no e-mail confirmation, no approval, no role, never on main. Its id starts with <code>test-</code>. Fictional data only.</p> }
    @else { <p class="hint">Fictional demo. Do not use real personal data. An administrator approves each request; signing up grants no access by itself.</p> }
    @if (errTitle()) {
      <div class="alert-err" role="alert" id="su-error" tabindex="-1">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div><b>{{errTitle()}}</b>
          @if (issues().length) { <ul>@for (i of issues(); track i.text) { <li>@if (i.id) { <a [href]="'#' + i.id">{{i.label}}</a>: }{{i.text}}</li> }</ul> }
        </div>
      </div>
    }
    <form id="su-form" (ngSubmit)="send()">
      <fieldset class="su-fields" [disabled]="busy()">
      <label><span>User ID <b class="req" title="required">*</b></span><input id="su-id" name="id" [(ngModel)]="id" required [pattern]="test() ? 'test-[a-z0-9][a-z0-9-]{1,38}' : '[a-z0-9-]{1,32}'" [placeholder]="test() ? 'test-yourname' : ''" [attr.aria-invalid]="fieldErrs()['id'] ? true : null" [attr.aria-describedby]="fieldErrs()['id'] ? 'su-id-err' : null" />
        @if (fieldErrs()['id']) { <span class="field-err" id="su-id-err">{{fieldErrs()['id']}}</span> }</label>
      <label><span>Display name <b class="req" title="required">*</b></span><input id="su-dn" name="dn" [(ngModel)]="dn" required maxlength="80" [attr.aria-invalid]="fieldErrs()['display_name'] ? true : null" [attr.aria-describedby]="fieldErrs()['display_name'] ? 'su-dn-err' : null" />
        @if (fieldErrs()['display_name']) { <span class="field-err" id="su-dn-err">{{fieldErrs()['display_name']}}</span> }</label>
      @if (!test()) { <label><span>E-mail <b class="req" title="required">*</b></span><input id="su-em" name="em" [(ngModel)]="em" required maxlength="254" autocomplete="off" [attr.aria-invalid]="fieldErrs()['email'] ? true : null" [attr.aria-describedby]="fieldErrs()['email'] ? 'su-em-err' : null" />
        @if (fieldErrs()['email']) { <span class="field-err" id="su-em-err">{{fieldErrs()['email']}}</span> }</label> }
      <label><span>Password (12 to 128 characters) <b class="req" title="required">*</b></span><input id="su-pw" type="password" name="pw" [(ngModel)]="pw" required minlength="12" maxlength="128" autocomplete="new-password" [attr.aria-invalid]="fieldErrs()['password'] ? true : null" [attr.aria-describedby]="fieldErrs()['password'] ? 'su-pw-err' : null" />
        @if (fieldErrs()['password']) { <span class="field-err" id="su-pw-err">{{fieldErrs()['password']}}</span> }</label>
      @if (!test()) { @for (sec of sections(); track sec.name) {
        @if (sec.name) { <h3 class="profile-section">{{sec.name}}</h3> }
        @for (f of sec.fields; track f.key) { <label><span>{{f.label}}@if (f.required) { <b class="req" title="required">*</b> } @else { <span class="opt">&nbsp;(optional)</span> }</span>
          @if (f.type==='select') { <select [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event"><option value="">-</option>@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
          @else { <input [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event" /> }</label> }
      } }
      </fieldset>
      <button id="su-send" [disabled]="busy()" [attr.aria-busy]="busy() || null">@if (busy()) {<span class="spin" aria-hidden="true"></span>{{test() ? 'Creating the test account…' : 'Creating account…'}}} @else {{{test() ? 'Create the test account' : 'Create account'}}}</button></form> }
  </ng-template>`,
})
export class SignupPage {
  protected state = signal<'loading' | 'closed' | 'form' | 'sent'>('loading'); protected fields = signal<F[]>([]);
  protected errTitle = signal(''); protected issues = signal<Issue[]>([]); protected fieldErrs = signal<Record<string, string>>({});
  protected msg = signal(''); protected confirmed = signal('');
  protected busy = signal(false); protected busyConfirm = signal(false);
  protected id = ''; protected dn = ''; protected em = ''; protected pw = ''; protected code = ''; protected vals: Record<string, string> = {};
  /** Fields grouped by their declared section, in schema order (the server sorts by order, key). */
  protected sections() {
    const out: { name: string; fields: F[] }[] = [];
    for (const f of this.fields()) {
      const name = f.section ?? '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.fields.push(f); else out.push({ name, fields: [f] });
    }
    return out;
  }
  private base = '/api/tenants/acme-demo/signup';
  /** Opened from a branch test sign-in (?branch=&ticket=): creates a test account on that branch only, through the dedicated route. */
  protected readonly test = signal<{ branch: string; ticket: string } | null>(null);
  protected loginUrl() { const t = this.test(); return t ? `/login?branch=${encodeURIComponent(t.branch)}&ticket=${encodeURIComponent(t.ticket)}` : '/login'; }
  async ngOnInit() {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search), branch = q.get('branch') ?? '', ticket = q.get('ticket') ?? '';
      if (branch && ticket) { this.test.set({ branch, ticket }); this.state.set('form'); return; }
    }
    try { const r = await fetch(`${this.base}/schema`); if (!r.ok) { this.state.set('closed'); return; } this.fields.set(((await r.json()).fields as F[]).filter((f) => !/(^|\.)(display_name|email|id|password)$/.test(f.key))); this.state.set('form'); } catch { this.state.set('closed'); }
  }
  /** A refused request: a visible summary (focus moved to it), each problem anchored to its field, field-level errors inline. */
  private showError(status: number, d: unknown, test: boolean) {
    this.fieldErrs.set({});
    if (status === 429) { this.errTitle.set('Too many requests.'); this.issues.set([{ text: 'Try again in a little while.' }]); this.focusErr(); return; }
    if (status === 404) { this.errTitle.set('Sign-up is closed.'); this.issues.set([]); this.focusErr(); return; }
    const raw = (d as { message?: unknown } | undefined)?.message;
    const msgs = (Array.isArray(raw) ? raw : [raw ?? (test ? 'The test account could not be created.' : 'The request could not be sent.')]).map(String);
    const fe: Record<string, string> = {};
    const items: Issue[] = msgs.map((m) => {
      const mm = m.match(/^\s*(id|display_name|email|password)\s*:\s*(.+)$/i);
      if (!mm) return { text: m };
      const key = mm[1].toLowerCase(), text = mm[2].charAt(0).toUpperCase() + mm[2].slice(1);
      fe[key] = text;
      const [label, id] = CORE[key];
      return { label, id, text };
    });
    this.errTitle.set(test ? 'The test account could not be created.' : 'Your request could not be sent.');
    this.issues.set(items);
    this.fieldErrs.set(fe);
    this.focusErr();
  }
  private readonly injector = inject(Injector);
  private focusErr() { afterNextRender(() => document.getElementById('su-error')?.focus(), { injector: this.injector }); }
  protected async send() {
    if (this.busy()) return;
    this.busy.set(true); this.errTitle.set(''); this.issues.set([]); this.fieldErrs.set({});
    try {
      const tt = this.test();
      if (tt) {
        const r = await fetch(`${this.base}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: tt.branch, ticket: tt.ticket, id: this.id, display_name: this.dn, password: this.pw }) });
        const d = await r.json().catch(() => ({}));
        this.pw = '';
        if (r.ok) { this.msg.set(d.note ?? 'Test account created.'); this.state.set('sent'); } else this.showError(r.status, d, true);
        return;
      }
      const values = Object.fromEntries(Object.entries(this.vals).filter(([, v]) => v !== ''));
      const r = await fetch(this.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.id, display_name: this.dn, email: this.em, password: this.pw, values }) });
      const d = await r.json().catch(() => ({}));
      this.pw = '';
      if (r.ok) { this.msg.set(d.message); this.state.set('sent'); } else this.showError(r.status, d, false);
    } catch {
      this.pw = '';
      this.errTitle.set('Your request could not be sent.'); this.issues.set([{ text: 'Check your connection and try again.' }]);
      this.focusErr();
    } finally { this.busy.set(false); }
  }
  protected async confirm() {
    if (this.busyConfirm()) return;
    this.busyConfirm.set(true);
    try {
      const r = await fetch(`${this.base}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.code }) });
      this.confirmed.set((await r.json().catch(() => ({}))).message ?? '');
    } catch { this.confirmed.set('The code could not be checked. Try again.'); } finally { this.busyConfirm.set(false); }
  }
}
