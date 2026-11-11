import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

/** What the console may show this person. Display only: the API checks the verified identity again on every call. */
/** `restricted`: the server lists its administrators (hosted demo). Locally the operator types the admin capability instead, so pages stay reachable. */
export interface Access { subject: string; admin: boolean; restricted: boolean; plugins: Record<string, boolean>; screens?: string[]; screenAccess?: boolean }

/** The admin screen a console URL belongs to (same ids as the API screen map). Unknown pages: undefined (decided by the legacy admin rule). */
export function screenOf(url: string): string | undefined {
  const p = '/' + url.split(/[?#]/)[0].replace(/^\/+/, '');
  const exact: Record<string, string> = { '/overview': 'dashboard', '/users': 'users', '/profile-fields': 'profile-fields', '/roles': 'roles', '/profile-reviews': 'profile-reviews', '/my-profile': 'my-profile', '/auth-methods': 'authentication', '/assignments': 'assignments', '/assignments/matrix': 'assignments', '/activation': 'activation', '/applications': 'applications', '/policies': 'policies', '/plugins': 'plugins', '/event-bus': 'event-bus', '/mcp': 'mcp', '/workflows': 'workflows', '/review': 'assignments' };
  if (exact[p]) return exact[p];
  if (p.startsWith('/workflows')) return 'workflows';
  const d = /^\/database\/([a-z]+)/.exec(p);
  if (d) return ({ home: 'dolt-home', branches: 'dolt-branches', history: 'dolt-history', compare: 'dolt-compare', data: 'dolt-data', sql: 'dolt-sql', pulls: 'dolt-pulls', edit: 'dolt-edit' } as Record<string, string>)[d[1]] ?? 'dolt-home';
  return undefined;
}
/** Screen access on: the screens list decides. Off (legacy): administrators open everything, others only their profile. */
export function canOpen(a: Access | null, screen: string | undefined): boolean {
  if (!a) return true;
  if (a.screenAccess && a.screens) return !screen || a.screens.includes(screen);
  return screen === 'my-profile' || a.admin || !a.restricted;
}
/** First screen of the console this person may open, for a redirect. The launchpad is open to every signed-in person. */
export function firstAllowedPath(a: Access | null): string {
  const order = ['/my-applications', '/overview', '/users', '/profile-reviews', '/assignments', '/database/pulls', '/database/branches', '/my-profile'];
  return order.find((p) => canOpen(a, screenOf(p))) ?? '/my-applications';
}

/** Administration pages: an ordinary account is sent to its own profile (the API refuses its admin calls anyway). */
export const accessGuard: CanActivateFn = async (_r, state) => {
  const s = inject(Session), router = inject(Router); const a = await s.loadAccess();
  if (a.screenAccess && a.screens) { const sc = screenOf(state.url); if (sc === 'dashboard' && !a.screens.includes(sc)) return router.createUrlTree([firstAllowedPath(a)]); // the default landing page: go to the first screen the person opens
    return !sc || a.screens.includes(sc) ? true : router.createUrlTree(['/access-denied'], { queryParams: { screen: sc } }); }
  return a.admin || !a.restricted ? true : router.createUrlTree(['/my-applications']);
};
/** A plugin page that is not enabled does not exist in the console: back to the overview. */
export const pluginGuard = (id: string): CanActivateFn => async () => {
  const s = inject(Session), router = inject(Router); const a = await s.loadAccess();
  return a.plugins?.[id] ? true : router.createUrlTree(['/overview']);
};
