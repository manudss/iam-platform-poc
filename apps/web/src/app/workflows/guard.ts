import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from '../session';

// Kept in its own dependency-light module so app.routes can reference the guard without pulling the
// whole workflows feature (ngx-vflow editor included) into the initial bundle: the pages lazy-load.

/** Route guard: the Workflows pages are inaccessible while the workflows-iga plugin is disabled. */
export const workflowsEnabledGuard: CanActivateFn = async () => {
  const s = inject(Session);
  const router = inject(Router);
  if (await s.refreshWorkflowsEnabled()) return true;
  s.say('The Workflows (IGA) plugin is disabled. Enable it from the Plugins page to use workflows.', 'info');
  return router.parseUrl('/plugins');
};
