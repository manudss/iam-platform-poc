import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Only the sign-in page is server-rendered: its methods list must be in the first HTML. Everything else stays
 * client-rendered (the console pages need a session and browser state; there is nothing public to gain there).
 */
export const serverRoutes: ServerRoute[] = [
  { path: 'login', renderMode: RenderMode.Server },
  { path: '**', renderMode: RenderMode.Client },
];
