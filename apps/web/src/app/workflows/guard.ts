import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from '../session';
import { adminRouteAccess } from '../access';

// Kept in its own dependency-light module so app.routes can reference the guard without pulling the
// whole workflows feature (ngx-vflow editor included) into the initial bundle: the pages lazy-load.

/** Route guard: the Workflows pages are inaccessible while the workflows-iga plugin is disabled. */
export const workflowsEnabledGuard: CanActivateFn = async (_route, state) => {
  const s = inject(Session);
  const router = inject(Router);
  const access = await adminRouteAccess(s, router, state.url);
  if (access !== true) return access;
  // Child guards run before Shell.ngOnInit. A fresh deep link has no branch yet;
  // /plugins then refuses the read rather than reporting that the plugin is disabled.
  if (!s.branch()) {
    try { await s.ensurePersonalBranch(); }
    catch {
      s.say('Could not open your working branch. Retry from the branch selector.', 'error');
      return router.parseUrl('/plugins');
    }
  }
  if (await s.refreshWorkflowsEnabled(true)) return true;
  s.say('The Workflows (IGA) plugin is disabled. Enable it from the Plugins page to use workflows.', 'info');
  return router.parseUrl('/plugins');
};
