import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

/** What the console may show this person. Display only: the API checks the verified identity again on every call. */
/** `restricted`: the server lists its administrators (hosted demo). Locally the operator types the admin capability instead, so pages stay reachable. */
export interface Access { subject: string; admin: boolean; restricted: boolean; plugins: Record<string, boolean> }

/** Administration pages: an ordinary account is sent to its own profile (the API refuses its admin calls anyway). */
export const accessGuard: CanActivateFn = async () => {
  const s = inject(Session), router = inject(Router); const a = await s.loadAccess();
  return a.admin || !a.restricted ? true : router.createUrlTree(['/my-profile']);
};
/** A plugin page that is not enabled does not exist in the console: back to the overview. */
export const pluginGuard = (id: string): CanActivateFn => async () => {
  const s = inject(Session), router = inject(Router); const a = await s.loadAccess();
  return a.plugins?.[id] ? true : router.createUrlTree(['/overview']);
};
