import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface F { key: string; label: string; type: string; help?: string; options?: { value: string; label: string }[]; required: boolean }

/** Public form (no sign-in). Closed unless an administrator opened and applied it. It only sends a request. */
@Component({
  selector: 'app-signup', imports: [FormsModule], styleUrl: './login.css',
  template: `
  <main class="login"><h1>Request an account</h1>
  @if (state()==='loading') { <p>Loading...</p> }
  @else if (state()==='closed') { <p id="su-closed" role="status">Sign-up is closed.</p> }
  @else if (state()==='sent') { <p id="su-sent" role="status">{{msg()}}</p>
    <form (ngSubmit)="confirm()"><label>Confirmation code<input name="code" [(ngModel)]="code" autocomplete="off" /></label><button id="su-confirm">Confirm</button></form>
    @if (confirmed()) { <p role="status">{{confirmed()}}</p> } }
  @else { <p class="hint">Fictional demo. Do not use real personal data. An administrator approves each request; signing up grants no access by itself.</p>
    @if (err()) { <p role="alert" id="su-error">{{err()}}</p> }
    <form id="su-form" (ngSubmit)="send()">
      <label>User ID<input name="id" [(ngModel)]="id" required pattern="[a-z0-9-]{1,32}" /></label>
      <label>Display name<input name="dn" [(ngModel)]="dn" required maxlength="80" /></label>
      <label>E-mail<input name="em" [(ngModel)]="em" required maxlength="254" autocomplete="off" /></label>
      <label>Password (12 to 128 characters)<input type="password" name="pw" [(ngModel)]="pw" required minlength="12" maxlength="128" autocomplete="new-password" /></label>
      @for (f of fields(); track f.key) { <label>{{f.label}}@if (f.required) { * }
        @if (f.type==='select') { <select [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event"><option value="">-</option>@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
        @else { <input [name]="f.key" [ngModel]="vals[f.key] ?? ''" (ngModelChange)="vals[f.key]=$event" /> }</label> }
      <button id="su-send">Send request</button></form> }
  </main>`,
})
export class SignupPage {
  protected state = signal<'loading' | 'closed' | 'form' | 'sent'>('loading'); protected fields = signal<F[]>([]); protected err = signal(''); protected msg = signal(''); protected confirmed = signal('');
  protected id = ''; protected dn = ''; protected em = ''; protected pw = ''; protected code = ''; protected vals: Record<string, string> = {};
  private base = '/api/tenants/acme-demo/signup';
  async ngOnInit() {
    try { const r = await fetch(`${this.base}/schema`); if (!r.ok) { this.state.set('closed'); return; } this.fields.set((await r.json()).fields); this.state.set('form'); } catch { this.state.set('closed'); }
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
