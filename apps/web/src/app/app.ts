import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiClient, Change } from './api';
import { PluginsAdmin } from './plugins-admin';

@Component({
  selector: 'app-root',
  imports: [FormsModule, PluginsAdmin],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('IAM platform POC');
  protected readonly api = new ApiClient();
  protected readonly user = signal('demo-alice');
  protected password = '';
  protected readonly loggedIn = signal(false);
  protected readonly message = signal('Local fictional demo. Not logged in.');
  protected readonly assignments = signal<{ identity_id: string; role_id: string }[]>([]);
  protected readonly activations = signal<{ seq: number; commit: string }[]>([]);
  protected readonly change = signal<Change | null>(null);
  protected identity = 'demo-bob';
  protected role = 'payment-approver';

  constructor() {
    if (location.pathname === '/callback') { // returned from the core login form
      const search = location.search; history.replaceState(null, '', '/'); // the code never stays in the address bar or history
      void this.run(async () => { await this.api.completeBrowserLogin(search, sessionStorage); this.loggedIn.set(true); this.message.set('Signed in through the browser flow (code + PKCE, state checked). In-memory token.'); await this.refresh(); });
    }
  }

  protected signIn() { return this.run(() => this.api.startBrowserLogin(sessionStorage, (u) => location.assign(u))); }

  protected async run(fn: () => Promise<void>) {
    try { await fn(); } catch (e) { this.message.set((e as Error).message); }
  }

  protected login() {
    return this.run(async () => {
      await this.api.login(this.user(), this.password); this.password = '';
      this.loggedIn.set(true); this.message.set('Logged in with the legacy JSON flow (in-memory token).'); await this.refresh();
    });
  }
  protected logout() { this.api.logout(); this.loggedIn.set(false); this.change.set(null); this.message.set('Logged out.'); }
  protected async refresh() { this.assignments.set(await this.api.assignments()); this.activations.set(await this.api.activations()); }

  protected simulate() {
    return this.run(async () => {
      const c = await this.api.simulate(this.identity, this.role); this.change.set(c);
      this.message.set(c.mergeable ? 'Simulation OK: no SoD violation, mergeable.' : `Simulation: ${c.violations.length} SoD violation(s), merge will be refused.`);
    });
  }
  protected merge() {
    return this.run(async () => {
      const r = await this.api.merge(this.change()!.branch);
      this.message.set(r.status === 409 ? 'Merge refused (409): SoD violation.' : `Merged into main: ${r.data.commit}`);
      if (r.status !== 409) this.change.set(null);
      await this.refresh();
    });
  }
  protected activate() {
    return this.run(async () => {
      const a = await this.api.activate();
      this.message.set(`Activated main head as #${a.seq} (event: ${a.event}).`); await this.refresh();
    });
  }
}
