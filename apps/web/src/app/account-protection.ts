import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface BlockRow { id: string; kind: string; message: string; origin: string; setBy: string; setAt: number; until?: number; hold?: boolean; reference: string }
export interface Listing { kinds: string[]; labels: Record<string, string>; messageMax: number; accounts: { subject: string; blocks: BlockRow[] }[] }
export interface SecurityForm { lockEnabled: boolean; maxFailures: number; windowMinutes: number; lockMinutes: number; adminMinLevel: number; adminMaxAgeMinutes: number; holdAfterVerification: boolean; appLevels: { id: string; level: number }[] }

/** The form shows minutes, the API stores seconds (and the parsed config reports milliseconds for the lockout): the three conversions live here, tested. */
export function toForm(c: { lockout: { enabled: boolean; maxFailures: number; windowMs: number; lockMs: number }; adminMinLevel: number; adminMaxAgeSeconds: number; holdAfterVerification: boolean; appLevels: Record<string, { minLevel: number }> }): SecurityForm {
  return { lockEnabled: c.lockout.enabled, maxFailures: c.lockout.maxFailures, windowMinutes: Math.round(c.lockout.windowMs / 60000), lockMinutes: Math.round(c.lockout.lockMs / 60000), adminMinLevel: c.adminMinLevel, adminMaxAgeMinutes: Math.round(c.adminMaxAgeSeconds / 60), holdAfterVerification: c.holdAfterVerification, appLevels: Object.entries(c.appLevels).map(([id, v]) => ({ id, level: v.minLevel })) };
}
export function fromForm(f: SecurityForm, keep: { exempt: string[]; hold: boolean }) {
  const appLevels: Record<string, { minLevel: number }> = {};
  for (const a of f.appLevels) if (a.id.trim() && a.level > 0) appLevels[a.id.trim()] = { minLevel: Number(a.level) };
  return { lockout: { enabled: f.lockEnabled, maxFailures: Number(f.maxFailures), windowSeconds: Math.round(f.windowMinutes * 60), lockSeconds: Math.round(f.lockMinutes * 60), hold: keep.hold, exempt: keep.exempt }, adminMinLevel: Number(f.adminMinLevel), adminMaxAgeSeconds: Math.round(f.adminMaxAgeMinutes * 60), holdAfterVerification: f.holdAfterVerification, appLevels };
}

/**
 * Account protection: block and unblock accounts (type, the message the person reads at sign-in, optional end) and the automatic protections
 * (lock after repeated failures, minimum level for administration and for each application). Blocks apply at once; settings are staged on the
 * working branch and go live with Review & Apply, like every other configuration.
 */
@Component({
  selector: 'app-account-protection',
  imports: [FormsModule],
  template: `
<div class="head"><div class="grow"><h2>Account protection</h2><span class="cnt">Block accounts, and set the automatic locks and sign-in levels.</span></div></div>
@if (error()) { <p class="msg error" role="alert" id="ap-error">{{error()}}</p> }
@if (note()) { <p class="msg" role="status" id="ap-note">{{note()}}</p> }
<div class="dtabs" role="tablist" aria-label="Account protection">
  <button role="tab" type="button" [class.on]="tab()==='blocks'" [attr.aria-selected]="tab()==='blocks'" (click)="tab.set('blocks')" id="ap-tab-blocks">Blocked accounts</button>
  <button role="tab" type="button" [class.on]="tab()==='settings'" [attr.aria-selected]="tab()==='settings'" (click)="tab.set('settings')" id="ap-tab-settings">Settings</button>
</div>
@if (tab()==='blocks') {
  <section class="card" id="ap-new">
    <h3>New action: block an account</h3>
    <label>Account<input name="subject" list="ap-people" [(ngModel)]="subject" placeholder="User id" autocomplete="off" id="ap-subject" /></label>
    <datalist id="ap-people">@for (p of people(); track p.id) { <option [value]="p.id">{{p.display_name}}</option> }</datalist>
    <label>Block type<select name="kind" [(ngModel)]="kind" id="ap-kind">@for (k of kinds(); track k) { <option [value]="k">{{label(k)}}</option> }</select></label>
    <label>Message shown to the person at sign-in<textarea name="message" rows="3" [maxlength]="max()" [(ngModel)]="message" id="ap-message"></textarea><small>{{message.length}} / {{max()}}. It appears after the first sign-in step succeeds, never before.</small></label>
    <label>Ends on (optional)<input type="datetime-local" name="until" [(ngModel)]="until" [disabled]="hold" id="ap-until" /></label>
    <label class="check"><input type="checkbox" name="hold" [(ngModel)]="hold" id="ap-hold" /> Keep blocked until an admin or a workflow unblocks it</label>
    <div class="row"><button class="danger" id="ap-block" [disabled]="busy() || !subject.trim() || !message.trim()" (click)="block()">{{label(kind)}}: block account</button></div>
    <p class="hint">You cannot block your own account, and the last active administrator cannot be blocked. Anyone who holds this right can lift any block.</p>
  </section>
  <section class="card" id="ap-list">
    <h3>Accounts with a block</h3>
    @if (loading()) { <p role="status">Loading…</p> }
    @for (a of accounts(); track a.subject) {
      <article class="blk"><b>{{a.subject}}</b>
        @for (b of a.blocks; track b.id) {
          <div class="mrow"><span class="pill">{{label(b.kind)}}</span><span class="grow"><span>{{b.message}}</span><small>{{b.reference}} · {{b.origin === 'admin' ? 'set by ' + b.setBy : 'automatic'}} · {{when(b.setAt)}}@if (b.until) { · until {{when(b.until)}} }@if (b.hold) { · until lifted }</small></span><button class="secondary" [disabled]="busy()" (click)="lift(a.subject, b)">Unblock</button></div>
        }
      </article>
    } @empty { @if (!loading()) { <p class="hint" id="ap-empty">No account is blocked.</p> } }
  </section>
} @else {
  <section class="card" id="ap-settings">
    <h3>Automatic lock</h3>
    <label class="check"><input type="checkbox" name="lockEnabled" [(ngModel)]="form.lockEnabled" id="ap-lock-on" /> Lock an account after repeated failed sign-ins</label>
    <label>Failed attempts<input type="number" min="1" max="100" name="maxFailures" [(ngModel)]="form.maxFailures" id="ap-max" /></label>
    <label>Within (minutes)<input type="number" min="1" max="1440" name="windowMinutes" [(ngModel)]="form.windowMinutes" id="ap-window" /></label>
    <label>Then lock for (minutes)<input type="number" min="1" max="43200" name="lockMinutes" [(ngModel)]="form.lockMinutes" id="ap-lock" /></label>
    <h3>Self sign-up</h3>
    <label class="check"><input type="checkbox" name="holdAfterVerification" [(ngModel)]="form.holdAfterVerification" id="ap-hold-verif" /> After approval, keep the new account blocked until an admin or a workflow unblocks it</label>
    <h3>Sign-in level</h3>
    <label>Administration pages need level (0 = off)<input type="number" min="0" max="10" name="adminMinLevel" [(ngModel)]="form.adminMinLevel" id="ap-admin-level" /></label>
    <label>Administration sign-in no older than (minutes, 0 = no limit)<input type="number" min="0" max="10080" name="adminMaxAge" [(ngModel)]="form.adminMaxAgeMinutes" id="ap-admin-age" /></label>
    <p class="hint">Levels are declared on the sign-in chains, never added up. A person who is below the level signs in again with a method that reaches it; nobody is offered a weaker one.</p>
    <h4>Applications</h4>
    @for (a of form.appLevels; track $index) {
      <div class="mrow"><input [name]="'app-id-' + $index" [(ngModel)]="a.id" placeholder="Application id" aria-label="Application id" /><input type="number" min="0" max="10" [name]="'app-level-' + $index" [(ngModel)]="a.level" aria-label="Minimum level" /><button class="secondary" type="button" (click)="removeApp($index)">Remove</button></div>
    }
    <button class="secondary" type="button" id="ap-add-app" (click)="addApp()">Add an application level</button>
    <div class="row"><button id="ap-save" [disabled]="busy()" (click)="save()">Save on my working branch</button></div>
    <p class="hint" id="ap-live">Live now: lock {{liveText()}}. Changes go live with Review &amp; Apply.</p>
  </section>
}`,
  styles: ['.card{margin-bottom:1rem}label{display:grid;gap:.25rem;margin:.6rem 0}.check{display:flex;gap:.5rem;align-items:center}.row{display:flex;gap:.5rem;margin-top:.75rem}.mrow{display:flex;gap:.75rem;align-items:center;padding:.4rem 0}.grow{flex:1;display:grid}.pill{padding:.1rem .5rem;border-radius:1rem;background:var(--bad-soft);color:var(--bad-ink);font-size:.85rem}.dtabs{display:flex;gap:.5rem;margin:.5rem 0 1rem}.dtabs .on{font-weight:700}.blk{border-top:1px solid var(--border);padding:.5rem 0}'],
})
export class AccountProtectionPage {
  private readonly s = inject(Session);
  protected readonly tab = signal<'blocks' | 'settings'>('blocks');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly note = signal('');
  protected readonly listing = signal<Listing>({ kinds: [], labels: {}, messageMax: 300, accounts: [] });
  protected readonly people = signal<{ id: string; display_name: string }[]>([]);
  protected readonly liveText = signal('');
  protected readonly kinds = computed(() => this.listing().kinds);
  protected readonly accounts = computed(() => this.listing().accounts);
  protected readonly max = computed(() => this.listing().messageMax);
  protected subject = ''; protected kind = 'suspended'; protected message = ''; protected until = ''; protected hold = false;
  protected form: SecurityForm = { lockEnabled: true, maxFailures: 5, windowMinutes: 15, lockMinutes: 15, adminMinLevel: 0, adminMaxAgeMinutes: 0, holdAfterVerification: false, appLevels: [] };
  private keep = { exempt: [] as string[], hold: false };
  constructor() { void this.load(); }
  protected label(k: string) { return this.listing().labels[k] ?? k; }
  protected when(t: number) { return new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  private async load() {
    this.loading.set(true); this.error.set('');
    try {
      const api = this.s.api;
      const [l, sec, users] = await Promise.all([api.raw<Listing>('GET', '/account-blocks'), api.raw<{ working: any; live: any }>('GET', '/security'), api.users().catch(() => [])]);
      this.listing.set(l.data); if (!this.kinds().includes(this.kind) && this.kinds().length) this.kind = this.kinds()[0];
      this.people.set(users.map((u: any) => ({ id: u.id, display_name: u.display_name })));
      this.form = toForm(sec.data.working); this.keep = { exempt: [...(sec.data.working.lockout.exempt ?? [])], hold: !!sec.data.working.lockout.hold };
      const lv = sec.data.live; this.liveText.set(lv.lockout.enabled ? `${lv.lockout.maxFailures} failures in ${Math.round(lv.lockout.windowMs / 60000)} min, locked ${Math.round(lv.lockout.lockMs / 60000)} min` : 'off');
    } catch (e) { this.error.set((e as Error).message); }
    this.loading.set(false);
  }
  private async run(fn: () => Promise<unknown>, ok: string) {
    this.busy.set(true); this.error.set(''); this.note.set('');
    try { await fn(); this.note.set(ok); await this.load(); }
    catch (e) { this.error.set((e as Error).message); }
    this.busy.set(false);
  }
  protected block() {
    const until = !this.hold && this.until ? new Date(this.until).getTime() : undefined;
    void this.run(async () => { await this.s.api.raw('POST', `/accounts/${encodeURIComponent(this.subject.trim())}/blocks`, { kind: this.kind, message: this.message.trim(), ...(until ? { until } : {}), hold: this.hold }); this.message = ''; this.until = ''; this.hold = false; this.subject = ''; }, 'Account blocked. It applies at its next sign-in.');
  }
  protected lift(subject: string, b: BlockRow) { void this.run(() => this.s.api.raw('DELETE', `/accounts/${encodeURIComponent(subject)}/blocks/${encodeURIComponent(b.id)}`), 'Block lifted.'); }
  protected addApp() { this.form.appLevels = [...this.form.appLevels, { id: '', level: 8 }]; }
  protected removeApp(i: number) { this.form.appLevels = this.form.appLevels.filter((_, n) => n !== i); }
  protected save() { void this.run(() => this.s.api.raw('PUT', '/security', { config: fromForm(this.form, this.keep) }), 'Saved on your working branch. It goes live with Review & Apply.'); }
}
