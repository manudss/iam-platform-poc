import { Component, effect, inject, signal } from '@angular/core';
import { Session } from './session';

interface Review { subject: string; changes: { key: string; label: string; from: unknown; to: unknown }[] }

/** Validators: see each person's pending profile edits (current value next to the proposal), accept (merge into main) or refuse (delete). An author cannot accept their own edits. */
@Component({
  selector: 'app-profile-reviews', styleUrl: './pages.css',
  template: `
  <p class="lead">Profile edits waiting for validation. This only has entries when the policy "Validated" is live (Profile fields).</p>
  <p class="hint">Live policy: <b id="pr-policy">{{policy()}}</b>. Accepting merges the person's personal change set into Dolt main; refusing deletes it. You cannot accept your own edits.</p>
  @if (note()) { <p role="status" class="msg" id="pr-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="pr-problem">{{problem()}}</p> }
  @for (r of reviews(); track r.subject) {
    <section class="card" [attr.data-subject]="r.subject"><h3>{{r.subject}}</h3>
      <div class="scroll"><table><thead><tr><th>Field</th><th>Live now</th><th>Proposed</th></tr></thead><tbody>
      @for (c of r.changes; track c.key) { <tr><td>{{c.label}}<br><small>{{c.key}}</small></td><td>{{c.from ?? '-'}}</td><td>{{c.to ?? '(removed)'}}</td></tr> }
      </tbody></table></div>
      <div class="row"><button class="primary" (click)="decide(r.subject, true)">Accept (merge into main)</button><button class="secondary" (click)="decide(r.subject, false)">Refuse</button></div>
    </section>
  } @empty { <section class="card"><p id="pr-empty">{{loaded() ? 'Nothing is waiting for validation.' : 'Loading...'}}</p></section> }`,
})
export class ProfileReviewsPage {
  protected readonly s = inject(Session);
  protected reviews = signal<Review[]>([]); protected policy = signal('immediate'); protected note = signal(''); protected problem = signal(''); protected loaded = signal(false);
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected async load() {
    try { const r = await this.s.api.raw<any>('GET', '/profile-reviews', undefined, this.h()); if (r.status >= 400) throw new Error(r.data.message ?? 'Cannot load'); this.reviews.set(r.data.reviews); this.policy.set(r.data.policy); this.problem.set(''); } catch (e) { this.problem.set((e as Error).message); }
    this.loaded.set(true);
  }
  protected async decide(id: string, accept: boolean) {
    try { const r = await this.s.api.raw<any>('POST', `/profile-reviews/${encodeURIComponent(id)}/${accept ? 'accept' : 'refuse'}`, {}, this.h()); if (r.status >= 400) throw new Error(r.data.message ?? 'Refused'); this.note.set(accept ? `Accepted: ${id}'s edits are live.` : `Refused: ${id}'s change set was deleted.`); await this.load(); } catch (e) { this.problem.set((e as Error).message); }
  }
}
