import { Injectable, signal } from '@angular/core';
import { ApiClient, Change } from './api';

export type Tone = 'info' | 'error';
export interface Assignment { identity_id: string; role_id: string }
export interface Activation { seq: number; commit: string }

/**
 * State shared by all pages of the console: the API client (token in memory only, lost on reload), the signed-in flag, the last
 * message shown in the status bar and the data of the IAM pages. Pages never keep their own copy of the token.
 */
@Injectable({ providedIn: 'root' })
export class Session {
  readonly api = new ApiClient();
  readonly loggedIn = signal(false);
  readonly user = signal('');
  readonly message = signal('');
  readonly tone = signal<Tone>('info');
  /** Admin capability token typed by the operator (local setups only; the hosted edge injects it server-side). Memory only. */
  readonly adminToken = signal('');
  readonly assignments = signal<Assignment[]>([]);
  readonly activations = signal<Activation[]>([]);
  readonly change = signal<Change | null>(null);

  say(text: string, tone: Tone = 'info') { this.message.set(text); this.tone.set(tone); }

  /** Marks the session signed in after a successful token exchange (browser or legacy flow). */
  signedIn(fallbackName = '') { this.loggedIn.set(true); this.user.set(this.api.identity || fallbackName); }

  signOut() {
    this.api.logout(); this.loggedIn.set(false); this.user.set(''); this.change.set(null);
    this.assignments.set([]); this.activations.set([]); this.adminToken.set(''); this.say('Signed out.');
  }

  async refresh() { this.assignments.set(await this.api.assignments()); this.activations.set(await this.api.activations()); }
}
