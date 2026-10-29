import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { PluginAdminClient, VersioningClient } from './api';
import { DoltExplorer, Tab } from './dolt-explorer';
import { PluginsAdmin } from './plugins-admin';
import { Session } from './session';

export const TABS: Tab[] = ['branches', 'history', 'compare', 'data', 'sql', 'pulls'];

interface Stat { label: string; value: string; to: string; hint: string }

/** Landing page: a few live numbers read from the same APIs the other pages use, each linking to its page. */
@Component({
  selector: 'app-overview', imports: [RouterLink], styleUrl: './pages.css',
  template: `
  <p class="lead">What is configured and what is moving, read live from the API. Fictional demo data.</p>
  <div class="stats">
    @for (c of stats(); track c.label) {
      <a class="card stat" [routerLink]="c.to"><span class="n">{{ c.value }}</span><span class="l">{{ c.label }}</span><small>{{ c.hint }}</small></a>
    }
  </div>
  <section class="card"><h3>Where to go</h3>
    <ul class="guide">
      <li><a routerLink="/assignments"><b>Assignments &amp; changes</b></a> simulate a role change on a Dolt branch, see Separation-of-Duties conflicts, merge.</li>
      <li><a routerLink="/activation"><b>Activation</b></a> publish the current Dolt main as the live policy, with a journal.</li>
      <li><a routerLink="/plugins"><b>Plugins</b></a> install, configure, grant and enable extensions from their manifests.</li>
      <li><a routerLink="/database/branches"><b>Database</b></a> branches, history, compare, data, SQL and pull requests on the versioned database.</li>
    </ul>
  </section>`,
})
export class OverviewPage implements OnInit {
  private readonly s = inject(Session);
  protected readonly stats = signal<Stat[]>([]);
  async ngOnInit() {
    const v = new VersioningClient(this.s.api), p = new PluginAdminClient(this.s.api);
    const ok = async <T>(f: () => Promise<T>) => { try { return await f(); } catch { return undefined; } };
    const [asg, act, br, prs, pl] = await Promise.all([ok(() => this.s.api.assignments()), ok(() => this.s.api.activations()), ok(() => v.branches()), ok(() => v.pulls('open')), ok(() => p.list())]);
    const n = (x: unknown[] | undefined) => (x ? String(x.length) : '-');
    this.stats.set([
      { label: 'Role assignments', value: n(asg), to: '/assignments', hint: 'on Dolt main' },
      { label: 'Activations', value: n(act), to: '/activation', hint: act?.length ? `latest #${act[act.length - 1].seq}` : 'none yet' },
      { label: 'Plugins', value: n(pl), to: '/plugins', hint: pl ? `${pl.filter((x) => x.enabled && !x.base).length} extension(s) enabled` : '' },
      { label: 'Dolt branches', value: n(br?.branches), to: '/database/branches', hint: br ? `default ${br.default}` : 'needs the admin capability' },
      { label: 'Open pull requests', value: n(prs?.pullRequests), to: '/database/pulls', hint: prs ? 'waiting for review' : 'needs the admin capability' },
    ]);
  }
}

/** Current assignments, then the simulate -> review -> merge flow of a role change. */
@Component({
  selector: 'app-assignments', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <div class="cols">
    <section class="card"><h3>Assignments on Dolt main</h3>
      <div class="scroll"><table class="grid" id="assignments"><thead><tr><th>Identity</th><th>Role</th></tr></thead><tbody>
        @for (a of s.assignments(); track a.identity_id + a.role_id) { <tr><td>{{ a.identity_id }}</td><td>{{ a.role_id }}</td></tr> }
        @empty { <tr><td colspan="2" class="empty">No assignment.</td></tr> }
      </tbody></table></div>
    </section>
    <section class="card"><h3>Simulate a change (on a Dolt branch)</h3>
      <p class="hint">The change is written on its own branch. It reaches main only through Merge, which is refused when a Separation-of-Duties rule is broken.</p>
      <div class="row">
        <label>Identity <input name="identity" [(ngModel)]="identity" /></label>
        <label>Role <input name="role" [(ngModel)]="role" /></label>
        <button type="button" (click)="simulate()">Simulate</button>
      </div>
      @if (s.change(); as c) {
        <div class="result" [class.bad]="!c.mergeable">
          <p>Branch <code>{{ c.branch }}</code> <span class="chip" [class.ok]="c.mergeable" [class.ko]="!c.mergeable">{{ c.mergeable ? 'mergeable' : 'blocked' }}</span></p>
          <ul>@for (v of c.violations; track v.roleA + v.roleB) { <li>SoD: {{ v.identity }} has {{ v.roleA }} and {{ v.roleB }}</li> }</ul>
          <button type="button" (click)="merge()">Merge into main</button>
        </div>
      }
    </section>
  </div>`,
})
export class AssignmentsPage implements OnInit {
  protected readonly s = inject(Session);
  protected identity = 'demo-bob';
  protected role = 'payment-approver';
  async ngOnInit() { try { await this.s.refresh(); } catch (e) { this.s.say((e as Error).message, 'error'); } }
  private async run(fn: () => Promise<void>) { try { await fn(); } catch (e) { this.s.say((e as Error).message, 'error'); } }
  protected simulate() {
    return this.run(async () => {
      const c = await this.s.api.simulate(this.identity, this.role); this.s.change.set(c);
      this.s.say(c.mergeable ? 'Simulation OK: no SoD violation, mergeable.' : `Simulation: ${c.violations.length} SoD violation(s), merge will be refused.`, c.mergeable ? 'info' : 'error');
    });
  }
  protected merge() {
    return this.run(async () => {
      const r = await this.s.api.merge(this.s.change()!.branch);
      this.s.say(r.status === 409 ? 'Merge refused (409): SoD violation.' : `Merged into main: ${r.data.commit}`, r.status === 409 ? 'error' : 'info');
      if (r.status !== 409) this.s.change.set(null);
      await this.s.refresh();
    });
  }
}

/** Explicit, journaled activation of the current Dolt main. */
@Component({
  selector: 'app-activation', styleUrl: './pages.css',
  template: `
  <section class="card"><h3>Activation (explicit, journaled)</h3>
    <p class="hint">Merging changes Dolt main; activating makes the current main head the policy the decision point uses, and records it.</p>
    <button type="button" (click)="activate()">Activate current main</button>
  </section>
  <section class="card"><h3>Journal</h3>
    <div class="scroll"><table class="grid"><thead><tr><th>#</th><th>Dolt commit</th></tr></thead><tbody>
      @for (a of s.activations(); track a.seq) { <tr><td>#{{ a.seq }}</td><td><code>{{ a.commit }}</code></td></tr> }
      @empty { <tr><td colspan="2" class="empty">Nothing activated yet.</td></tr> }
    </tbody></table></div>
  </section>`,
})
export class ActivationPage implements OnInit {
  protected readonly s = inject(Session);
  async ngOnInit() { try { await this.s.refresh(); } catch (e) { this.s.say((e as Error).message, 'error'); } }
  protected async activate() {
    try { const a = await this.s.api.activate(); this.s.say(`Activated main head as #${a.seq} (event: ${a.event}).`); await this.s.refresh(); }
    catch (e) { this.s.say((e as Error).message, 'error'); }
  }
}

@Component({ selector: 'app-plugins-page', imports: [PluginsAdmin], template: `<app-plugins-admin [api]="s.api" [pluginId]="id()" (opened)="open($event)" />` })
export class PluginsPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly id = signal<string | null>(this.route.snapshot.paramMap.get('id'));
  protected open(id: string | null) { this.id.set(id); void this.router.navigate(['/plugins', ...(id ? [id] : [])]); }
}

/** One instance serves every /database/:tab, so branch, comparison and form state survive moving between sections. */
@Component({ selector: 'app-explorer-page', imports: [DoltExplorer], template: `<app-dolt-explorer [api]="s.api" [section]="tab()" (navigate)="go($event)" />` })
export class ExplorerPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected readonly tab = signal<Tab>('branches');
  constructor() {
    inject(ActivatedRoute).paramMap.subscribe((m) => {
      const t = m.get('tab') as Tab;
      if (TABS.includes(t)) this.tab.set(t); else void this.router.navigateByUrl('/database/branches', { replaceUrl: true });
    });
  }
  protected go(t: Tab) { if (t !== this.tab()) { this.tab.set(t); void this.router.navigate(['/database', t]); } }
}
