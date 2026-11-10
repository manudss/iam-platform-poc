import { Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Session } from './session';
import { firstAllowedPath } from './access';

const LABEL: Record<string, string> = { dashboard: 'the Dashboard', users: 'Users', 'profile-fields': 'Profile fields', roles: 'Roles', 'profile-reviews': 'Profile reviews', authentication: 'Authentication', assignments: 'Assignments', activation: 'Activation', applications: 'Applications', policies: 'Policies', plugins: 'Plugins', 'event-bus': 'the Event bus', mcp: 'MCP', workflows: 'Workflows', 'dolt-home': 'Database home', 'dolt-pulls': 'Pull requests', 'dolt-compare': 'Compare', 'dolt-history': 'History', 'dolt-branches': 'Branches', 'dolt-data': 'Database data', 'dolt-edit': 'Database edit', 'dolt-sql': 'Database SQL' };

/** Reached by a typed URL or an old link: the menu already hides the screens the person cannot open. */
@Component({ selector: 'app-access-denied', template: `
<section class="card deny" role="alert" style="max-width:520px;margin:32px auto;text-align:center">
  <div aria-hidden="true" style="width:56px;height:56px;border-radius:50%;background:var(--bad-soft);color:var(--bad-ink);display:grid;place-items:center;margin:0 auto 12px;font-size:26px">&#128274;</div>
  <h3 style="margin:0 0 6px">You do not have access to {{ name }}</h3>
  <p class="hint" style="margin:0 0 14px">Your roles do not open this screen. Ask an administrator for a role that opens it.</p>
  <button type="button" id="deny-home" (click)="go()">Go to {{ homeLabel }}</button>
</section>` })
export class AccessDeniedPage {
  private readonly route = inject(ActivatedRoute); private readonly router = inject(Router); private readonly s = inject(Session);
  protected readonly screen = this.route.snapshot.queryParamMap.get('screen') ?? '';
  protected readonly name = LABEL[this.screen] ?? 'this screen';
  protected readonly target = firstAllowedPath(this.s.access());
  protected readonly homeLabel = this.target === '/my-profile' ? 'My profile' : 'the first screen you can open';
  protected go() { void this.router.navigateByUrl(this.target); }
}
