import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Server-rendered routes: /login (its methods list must be in the first HTML) and /my-applications (the
 * signed-in home renders from the session cookie, docs/session.md). Everything else stays client-rendered
 * (the console pages need browser state; there is nothing public to gain there).
 */
export const serverRoutes: ServerRoute[] = [
  { path: 'login', renderMode: RenderMode.Server },
  { path: 'my-applications', renderMode: RenderMode.Server },
  { path: '**', renderMode: RenderMode.Client },
];
