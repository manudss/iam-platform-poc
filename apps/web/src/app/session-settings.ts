import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

interface SessionConfig { ttlSeconds: number; warnSeconds: number; maxSeconds: number; allowExtend: boolean }
interface SessionState { working: SessionConfig; live: SessionConfig; defaults: SessionConfig; limits: Record<string, [number, number]> }

/** Session length settings (docs/session.md): saved on the working branch like the other sign-in settings, live after Apply, used by the next sign-in. */
@Component({
  selector: 'app-session-settings', imports: [FormsModule],
  template: `
  <section class="card" id="session-settings"><h3>Session length</h3>
    <p class="hint">How long people stay signed in. The session is a token that runs out after the <b>session length</b>; a bar in the top bar shows what is left. Shortly before the end a dialog offers to <b>stay signed in</b>, which renews the token without a new password, until the <b>maximum total</b> since the sign-in is reached. Changes apply to the next sign-in and become live after Apply, like the other sign-in settings.</p>
    @if (note()) { <p role="status" class="msg" id="session-note">{{note()}}</p> }
    @if (problem()) { <p role="alert" class="msg bad" id="session-problem">{{problem()}}</p> }
    @if (state(); as st) {
      <div class="row">
        <label>Session length (minutes)<input type="number" name="sessMin" [(ngModel)]="minutes" min="1" max="1440" /></label>
        <label>Warning before the end (seconds)<input type="number" name="sessWarn" [(ngModel)]="warn" min="10" max="3600" /></label>
        <label>Maximum total (hours)<input type="number" name="sessMax" [(ngModel)]="hours" min="1" max="168" step="0.5" /></label>
        <label class="inline"><input type="checkbox" name="sessExt" [(ngModel)]="allowExtend" /> Allow staying signed in</label>
        <button type="button" id="session-save" (click)="save()" [disabled]="busy()">Save on this branch</button>
        <button type="button" class="secondary" id="session-defaults" (click)="fill(st.defaults)">Use defaults</button>
      </div>
      <p class="hint" id="session-live">Live now: {{describe(st.live)}}.@if (differs(st)) { <span class="pill warn"> Saved on this branch, not live until Apply</span> }</p>
    }
  </section>`,
})
export class SessionSettings implements OnInit {
  private readonly s = inject(Session);
  protected readonly state = signal<SessionState | null>(null);
  protected readonly note = signal(''); protected readonly problem = signal(''); protected readonly busy = signal(false);
  protected minutes = 30; protected warn = 120; protected hours = 8; protected allowExtend = true;
  private headers(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  async ngOnInit() { await this.load(); }
  private async load() {
    try { const r = await this.s.api.raw<SessionState>('GET', '/session'); this.state.set(r.data); this.fill(r.data.working); } catch (e) { this.problem.set((e as Error).message); }
  }
  protected fill(c: SessionConfig) { this.minutes = c.ttlSeconds / 60; this.warn = c.warnSeconds; this.hours = c.maxSeconds / 3600; this.allowExtend = c.allowExtend; }
  protected describe(c: SessionConfig) { return `${c.ttlSeconds / 60} min per session, warning ${c.warnSeconds} s before the end, ${c.allowExtend ? 'renewable up to ' + c.maxSeconds / 3600 + ' h in total' : 'not renewable'}`; }
  protected differs(st: SessionState) { return JSON.stringify(st.working) !== JSON.stringify(st.live); }
  protected async save() {
    this.busy.set(true); this.problem.set(''); this.note.set('');
    try {
      const config = { ttlSeconds: Math.round(this.minutes * 60), warnSeconds: Math.round(this.warn), maxSeconds: Math.round(this.hours * 3600), allowExtend: this.allowExtend };
      await this.s.api.raw('PUT', '/session', { config }, this.headers());
      await this.load(); this.note.set('Saved on this branch. It applies to the next sign-in once applied to main.');
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
}
