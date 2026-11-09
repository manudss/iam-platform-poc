import { Brand, Branding } from './branding';
import { Component, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeSwitch } from './theme-switch';

interface F { key: string; label: string; type: string; help?: string; options?: { value: string; label: string }[]; required: boolean; section?: string }

/** Public account-request form on its own /signup page (no sign-in). Closed unless an administrator opened and applied it. It only sends a request. */
@Component({
  selector: 'app-signup', imports: [FormsModule, NgTemplateOutlet, ThemeSwitch, Brand], styleUrl: './login.css',
  template: `
  <div class="auth-bg" aria-hidden="true"><img src="https://picsum.photos/1920/1080" alt="" loading="eager"></div>
  <div class="auth-veil" aria-hidden="true"></div>
  <app-theme-switch class="auth-theme" />
  <main class="login"><section class="card hero signup-card">
    <p style="margin:0"><a class="back" href="/login">&lsaquo; Back to sign in</a></p>
    <div class="brand"><div class="brand-title"><app-brand /></div></div>
    <h1 class="page-title">Request an account</h1>
    <ng-container *ngTemplateOutlet="body" />
    <p class="foot">Fictional demo data only. Do not enter real data. <a href="/privacy">Politique de confidentialité / Privacy</a> · <a href="/about">About this demo</a></p>
  </section></main>
  <ng-template #body>
  @if (state()==='loading') { <p>Loading...</p> }
  @else if (state()==='closed') { <p id="su-closed" role="status">Sign-up is closed.</p> }
  @else if (state()==='sent') { <p id="su-sent" role="status">{{msg()}}</p>
    <form (ngSubmit)="confirm()"><label>Confirmation code<input name="code" [(ngModel)]="code" autocomplete="off" /></label><button id="su-confirm">Confirm</button></form>
    @if (confirmed()) { <p role="status">{{confirmed()}}</p> } }
  @else { <p class="hint">Fictional demo. Do not use real personal data. An administrator approves each request; signing up grants no access by itself.</p>
    @if (err()) { <p role="alert" id="su-error">{{err()}}</p> }
    <form id="su-form" (ngSubmit)="send()">
      <label>User ID <b class="req" title="required">*</b><input name="id" [(ngModel)]="id" required pattern="[a-z0-9-]{1,32}" /></label>
      <label>Display name <b class="req" title="required">*</b><input name="dn" [(ngModel)]="dn" required maxlength="80" /></label>
      <label>E-mail <b class="req" title="required">*</b><input name="em" [(ngModel)]="em" required maxlength="254" autocomplete="off" /></label>
      <label>Password (12 to 128 characters) <b class="req" title="required">*</b><input type="password" name="pw" [(ngModel)]="pw" required minlength="12" maxlength="128" autocomplete="new-password" /></label>
      @for (sec of sections(); track sec.name) {
        @if (sec.name) { <h3 class="profile-section">{{sec.name}}</h3> }
        @for (f of sec.fields; track f.key) { <label>{{f.label}}@if (f.required) { <b class="req" title="required">*</b> }
          @if (f.type==='select') { <select [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event"><option value="">-</option>@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
          @else { <input [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event" /> }</label> }
      }
      <button id="su-send">Send request</button></form> }
  </ng-template>`,
})
export class SignupPage {
  protected state = signal<'loading' | 'closed' | 'form' | 'sent'>('loading'); protected fields = signal<F[]>([]); protected err = signal(''); protected msg = signal(''); protected confirmed = signal('');
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
  async ngOnInit() {
    try { const r = await fetch(`${this.base}/schema`); if (!r.ok) { this.state.set('closed'); return; } this.fields.set(((await r.json()).fields as F[]).filter((f) => !/(^|\.)(display_name|email|id|password)$/.test(f.key))); this.state.set('form'); } catch { this.state.set('closed'); }
  }
  protected async send() {
    this.err.set('');
    const values = Object.fromEntries(Object.entries(this.vals).filter(([, v]) => v !== ''));
    const r = await fetch(this.base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: this.id, display_name: this.dn, email: this.em, password: this.pw, values }) });
    const d = await r.json().catch(() => ({}));
    this.pw = '';
    if (r.ok) { this.msg.set(d.message); this.state.set('sent'); } else this.err.set(r.status === 429 ? 'Too many requests. Try again later.' : r.status === 404 ? 'Sign-up is closed.' : Array.isArray(d.message) ? d.message.join(' ') : d.message ?? 'Refused');
  }
  protected async confirm() {
    const r = await fetch(`${this.base}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: this.code }) });
    this.confirmed.set((await r.json().catch(() => ({}))).message ?? '');
  }
}
