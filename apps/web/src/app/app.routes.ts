import { Routes, UrlMatcher, UrlSegment } from '@angular/router';
import { authGuard } from './auth';
import { CallbackPage, LoginPage } from './login';
import { ActivationPage, AssignmentsPage, ExplorerPage, OverviewPage, PluginsPage } from './pages';
import { Shell } from './shell';

/** /plugins and /plugins/:id share one route (and so one component instance): selecting a plugin only updates the address. */
export const pluginsMatcher: UrlMatcher = (segs: UrlSegment[]) =>
  segs[0]?.path === 'plugins' && segs.length <= 2 ? { consumed: segs, posParams: segs[1] ? { id: segs[1] } as Record<string, UrlSegment> : ({} as Record<string, UrlSegment>) } : null;

export const routes: Routes = [
  { path: 'callback', component: CallbackPage },
  { path: 'login', component: LoginPage, title: 'Sign in' },
  {
    path: '', component: Shell, canActivate: [authGuard], children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', component: OverviewPage, title: 'Dashboard' },
      { path: 'assignments', component: AssignmentsPage, title: 'Assignments & changes' },
      { path: 'activation', component: ActivationPage, title: 'Activation' },
      { matcher: pluginsMatcher, component: PluginsPage, title: 'Plugins' },
      { path: 'database', pathMatch: 'full', redirectTo: 'database/branches' },
      { path: 'database/:tab', component: ExplorerPage, title: 'Database (Dolt)' },
    ],
  },
  { path: '**', redirectTo: '' },
];
