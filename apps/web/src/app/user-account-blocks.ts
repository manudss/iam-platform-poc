import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { BlockRow, Listing } from './account-protection';
import { activeBlocks } from './account-state';

/** Operational controls, deliberately outside the branch-profile form. */
@Component({ selector: 'app-user-account-blocks', imports: [FormsModule], template: `
<section class="panel" id="user-account-blocks" aria-labelledby="user-blocks-title">
  <h4 id="user-blocks-title">Account blocks</h4>
  <p class="hint">Live security state, independent of the selected branch. Block and unblock take effect immediately for sign-in, not when you save this profile or use Review &amp; Apply. They do not end existing sessions.</p>
  @if (error()) { <p role="alert" class="msg error">{{error()}}</p> }
  @if (note()) { <p role="status" class="msg">{{note()}}</p> }
  <button type="button" class="secondary" (click)="load()" [disabled]="busy()">Refresh live blocks</button>
  @if (loading()) { <p role="status">Loading live blocks…</p> }
  @else if (ready()) {
    <p class="block-status"><strong>{{active().length ? 'Blocked' : 'No active block'}}</strong> · {{active().length}} active</p>
    @for (b of rows(); track b.id) {
      <article class="block-row" [attr.data-active]="isActive(b)">
        <strong>{{label(b.kind)}} · {{isActive(b) ? 'Active' : 'Expired'}}</strong>
        <p>{{b.message}}</p>
        <small>{{b.reference}} · {{b.origin}} · set by {{b.setBy}} · {{when(b.setAt)}}<br>{{b.hold ? 'Until explicitly lifted' : b.until ? 'Ends '+when(b.until) : 'No automatic end'}}</small>
        <button type="button" class="secondary" (click)="confirmLift(b)" [disabled]="busy() || testMode()">{{isActive(b) ? 'Lift this block' : 'Remove expired block'}}</button>
      </article>
    }
    <p class="hint">Lifting one block leaves every other block in place. Profile sign-in settings and credentials are separate.</p>
    <fieldset [disabled]="busy() || testMode() || self() || !!confirmation()">
      <legend>Block this account</legend>
      <label>Block type<select name="ubKind" [(ngModel)]="kind" id="ub-kind">@for (k of listing().kinds; track k) { <option [value]="k">{{label(k)}}</option> }</select></label>
      <label>Message shown after the first sign-in step<textarea id="ub-message" name="ubMessage" rows="3" [maxlength]="listing().messageMax" [(ngModel)]="message"></textarea></label>
      <label>Ends on (optional)<input id="ub-until" type="datetime-local" name="ubUntil" [(ngModel)]="until" [disabled]="hold" /></label>
      <label class="inline"><input id="ub-hold" type="checkbox" name="ubHold" [(ngModel)]="hold" /> Keep blocked until an administrator or workflow lifts it</label>
      <button type="button" class="danger" id="ub-block" [disabled]="!message.trim() || !listing().kinds.includes(kind)" (click)="confirmBlock()">Block {{userId}}</button>
    </fieldset>
    @if (self()) { <p class="hint">You cannot block your own account.</p> }
    @if (testMode()) { <p class="hint">Live security changes are unavailable in a branch-test session.</p> }
    <p class="hint">The server also protects the last active administrator. Anyone holding the block-management right can lift a block, regardless of its origin.</p>
  }
  @if (confirmation(); as c) {
    <div class="confirmation" role="group" aria-label="Confirm live security change">
      <strong>{{c.action === 'block' ? 'Block' : 'Lift block on'}} {{c.subject}} now?</strong>
      <p>{{c.action === 'block' ? label(c.kind!) + ': ' + c.message : label(c.block!.kind) + ': ' + c.block!.message}}</p>
      <p>This changes live sign-in immediately. Canceling or discarding the profile will not undo it.</p>
      <button type="button" class="danger" id="ub-confirm" [disabled]="busy()" (click)="execute()">Confirm live change</button>
      <button type="button" class="secondary" [disabled]="busy()" (click)="confirmation.set(null)">Cancel change</button>
    </div>
  }
</section>`, styles: [`
:host{display:block;margin-block:1rem}.panel{padding:1rem;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
h4{margin:0 0 .5rem}p{overflow-wrap:anywhere}.hint,small{color:var(--label)}.hint{font-size:.84rem}label{display:grid;gap:.3rem;margin:.7rem 0}.inline{display:flex;align-items:center;gap:.5rem}input,select,textarea{max-width:100%;box-sizing:border-box;width:100%}.inline input{width:auto}fieldset{min-width:0;border:1px solid var(--line);padding:.7rem}legend{font-weight:600}.block-row{border-top:1px solid var(--line);padding:.8rem 0}.block-row p{margin:.4rem 0}.block-row small{display:block;overflow-wrap:anywhere}.block-row button{margin-top:.5rem}.block-status{color:var(--ink)}.confirmation{border:2px solid var(--bad);padding:.8rem;margin-top:1rem;border-radius:var(--radius);background:var(--card)}button{white-space:normal}button.danger{background:var(--bad-soft);color:var(--bad-ink);border:1px solid var(--bad)}
`] })
export class UserAccountBlocks implements OnChanges, OnDestroy {
  @Input({ required: true }) userId = '';
  @Output() changed = new EventEmitter<void>();
  private readonly s = inject(Session);
  readonly listing = signal<Listing>({ kinds: [], labels: {}, messageMax: 300, accounts: [] });
  readonly loading = signal(false); readonly busy = signal(false); readonly ready = signal(false);
  readonly error = signal(''); readonly note = signal(''); readonly now = signal(Date.now());
  readonly confirmation = signal<null | { action: 'block' | 'lift'; subject: string; block?: BlockRow; kind?: string; message?: string; until?: number; hold?: boolean }>(null);
  kind = 'suspended'; message = ''; until = ''; hold = false;
  private serverOffset = 0;
  private generation = 0; private targetEpoch = 0;
  private timer = typeof window === 'undefined' ? undefined : setInterval(() => this.now.set(Date.now() + this.serverOffset), 1000);
  ngOnChanges() { ++this.targetEpoch; this.confirmation.set(null); this.message = ''; this.until = ''; this.hold = false; this.note.set(''); void this.load(); }
  ngOnDestroy() { ++this.targetEpoch; ++this.generation; clearInterval(this.timer); }
  self() { return this.s.api.identity === this.userId; }
  testMode() { return !!this.s.testBranch(); }
  rows() { return this.listing().accounts.find(a => a.subject === this.userId)?.blocks ?? []; }
  active() { return activeBlocks(this.rows(), this.now()); }
  isActive(b: BlockRow) { return activeBlocks([b], this.now()).length > 0; }
  label(k: string) { return this.listing().labels[k] ?? k; }
  when(t: number) { return new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  async load() {
    const generation = ++this.generation, subject = this.userId;
    this.loading.set(true); this.ready.set(false); this.error.set('');
    try {
      const r = await this.s.api.raw<Listing>('GET', '/account-blocks', undefined, this.headers());
      if (generation !== this.generation || subject !== this.userId) return;
      if (r.status >= 400 || !Array.isArray(r.data?.accounts) || !Array.isArray(r.data?.kinds)) throw new Error('Live block state unavailable. Refresh before changing it.');
      this.serverOffset = typeof r.data.asOf === 'number' ? r.data.asOf - Date.now() : 0; this.listing.set(r.data); this.now.set(Date.now() + this.serverOffset); this.ready.set(true);
    } catch (e) { if (generation === this.generation) this.error.set((e as Error).message); }
    finally { if (generation === this.generation) this.loading.set(false); }
  }
  confirmBlock() {
    if (!this.ready() || this.busy() || this.testMode() || this.self() || !this.message.trim() || !this.listing().kinds.includes(this.kind)) return;
    const until = !this.hold && this.until ? new Date(this.until).getTime() : undefined;
    if (until !== undefined && (!Number.isFinite(until) || until <= this.now())) { this.error.set('Choose a future end date.'); return; }
    this.confirmation.set({ action: 'block', subject: this.userId, kind: this.kind, message: this.message.trim(), ...(until === undefined ? {} : { until }), hold: this.hold });
  }
  confirmLift(block: BlockRow) { if (this.ready() && !this.busy() && !this.testMode()) this.confirmation.set({ action: 'lift', subject: this.userId, block: { ...block } }); }
  private headers(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  async execute() {
    const c = this.confirmation(); if (!c || c.subject !== this.userId || this.busy() || this.testMode() || (c.action === 'block' && this.self())) return;
    this.busy.set(true); this.error.set(''); this.note.set(''); this.confirmation.set(null);
    const subject = this.userId, epoch = this.targetEpoch;
    try {
      const path = '/accounts/' + encodeURIComponent(subject) + '/blocks';
      const r = c.action === 'block'
        ? await this.s.api.raw<any>('POST', path, { kind: c.kind, message: c.message, ...(c.until === undefined ? {} : { until: c.until }), hold: c.hold }, this.headers())
        : await this.s.api.raw<any>('DELETE', path + '/' + encodeURIComponent(c.block!.id), undefined, this.headers());
      if (r.status >= 400) throw new Error(r.data?.message ?? 'Security change refused');
      this.changed.emit();
      if (subject === this.userId && epoch === this.targetEpoch) { this.message = ''; this.until = ''; this.hold = false; this.note.set(c.action === 'block' ? 'Block applied to live sign-in.' : 'This block was lifted. Other blocks and profile restrictions remain.'); await this.load(); }
    } catch (e) { if (subject === this.userId && epoch === this.targetEpoch) { this.error.set('Change not confirmed: ' + (e as Error).message + '. Refresh live state before trying again; no automatic retry.'); this.ready.set(false); } }
    finally { this.busy.set(false); }
  }
}
