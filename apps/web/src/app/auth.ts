import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

export const RETURN_KEY = 'iam.return';

/** Pages need a token. A still-valid saved token is restored on startup; otherwise sign in and come back to the requested page. */
export const authGuard: CanActivateFn = (_route, state) => {
  const s = inject(Session);
  if (s.loggedIn()) return true;
  try { sessionStorage.setItem(RETURN_KEY, state.url); } catch { /* storage blocked: land on the overview after sign-in */ }
  return inject(Router).createUrlTree(['/login']);
};

/** Only same-origin app paths are accepted as a return target (never an absolute URL). */
export function safeReturn(url: string | null): string {
  return url && /^\/[A-Za-z0-9/_-]*(\?[^#]*)?$/.test(url) && !url.startsWith('//') && !url.startsWith('/login') && !url.startsWith('/callback') ? url : '/overview';
}
