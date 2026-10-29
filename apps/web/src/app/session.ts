import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { ApiClient, Change } from './api';
import { Router } from '@angular/router';

export type Tone = 'info' | 'error';
export interface Assignment { identity_id: string; role_id: string }
export interface Activation { seq: number; commit: string }

/**
 * State shared by all pages of the console: the API client (token in memory only, lost on reload), the signed-in flag, the last
 * message shown in the status bar and the data of the IAM pages. Pages never keep their own copy of the token.
 */
@Injectable({ providedIn: 'root' })
export class Session implements OnDestroy {
  private readonly router = inject(Router);
  readonly expired = signal(false);
  private expiryTimer?: ReturnType<typeof setTimeout>;
  readonly api = new ApiClient('acme-demo', (...args) => fetch(...args), () => this.expire());
  readonly loggedIn = signal(false);
  readonly user = signal('');
  readonly branch = signal('');
  readonly branchEpoch = signal(0);
  selectBranch(branch:string){this.api.branch=branch;this.branch.set(branch);this.branchEpoch.update(x=>x+1);this.change.set(null);this.assignments.set([]);this.activations.set([]);}

  readonly message = signal('');
  readonly tone = signal<Tone>('info');
  /** Admin capability token typed by the operator (local setups only; the hosted edge injects it server-side). Memory only. */
  readonly adminToken = signal('');
  readonly assignments = signal<Assignment[]>([]);
  readonly activations = signal<Activation[]>([]);
  readonly change = signal<Change | null>(null);

  ngOnDestroy() { clearTimeout(this.expiryTimer); }

  say(text: string, tone: Tone = 'info') { this.message.set(text); this.tone.set(tone); }

  /** Marks the session signed in after a successful token exchange (browser or legacy flow). */
  signedIn(fallbackName = '') {
    this.expired.set(false); this.loggedIn.set(true); this.user.set(this.api.identity || fallbackName);
    clearTimeout(this.expiryTimer);
    const expires = this.api.expiresAt;
    if (expires !== null) this.expiryTimer = setTimeout(() => this.expire(), Math.max(0, expires - Date.now()));
  }

  /** No request is queued or replayed. Returning to a page requires a fresh, explicit action. */
  expire() {
    if (!this.loggedIn()) return;
    const path = this.router.url;
    try { if (path !== '/login' && !path.startsWith('/callback')) sessionStorage.setItem('iam.return', path); } catch { /* storage blocked */ }
    this.signOut();
    this.say('', 'info');
    this.expired.set(true);
    void this.router.navigateByUrl('/login', { replaceUrl: true });
  }

  signOut() {
    this.expired.set(false); clearTimeout(this.expiryTimer);
    this.api.logout();this.selectBranch(''); this.loggedIn.set(false); this.user.set(''); this.change.set(null);
    this.assignments.set([]); this.activations.set([]); this.adminToken.set(''); this.say('Signed out.');
  }

  async refresh() { this.assignments.set(await this.api.assignments()); this.activations.set(await this.api.activations()); }
}
