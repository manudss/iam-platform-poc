import { Routes, UrlMatcher, UrlSegment } from '@angular/router';
import { authGuard } from './auth';
import { CallbackPage, LoginPage } from './login';
import { ActivationPage, AssignmentsPage, ExplorerPage, OverviewPage, PluginsPage } from './pages';
import { UsersPage } from './users';
import { AuthMethodsPage } from './auth-methods';
import { ProfileFieldsPage } from './profile-fields';
import { MyProfilePage } from './my-profile';
import { SignupPage } from './signup-page';
import { OrganizationsPage } from './organizations';
import { ApplicationsPage } from './applications';
import { RolesAdminPage } from './roles-admin';
import { ProfileReviewsPage } from './profile-reviews';
import { BusObserverPage } from './bus-observer';
import { WorkflowEditPage, WorkflowRunPage, WorkflowsPage, workflowsEnabledGuard } from './workflows';
import { accessGuard, pluginGuard } from './access';
import { Shell } from './shell';

/** /plugins and /plugins/:id share one route (and so one component instance): selecting a plugin only updates the address. */
export const pluginsMatcher: UrlMatcher = (segs: UrlSegment[]) =>
  segs[0]?.path === 'plugins' && segs.length <= 2 ? { consumed: segs, posParams: segs[1] ? { id: segs[1] } as Record<string, UrlSegment> : ({} as Record<string, UrlSegment>) } : null;

export const routes: Routes = [
  { path: 'callback', component: CallbackPage },
  { path: 'signup', component: SignupPage, title: 'Request an account' },
  { path: 'login', component: LoginPage, title: 'Sign in' },
  {
    path: '', component: Shell, canActivate: [authGuard], children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', component: OverviewPage, title: 'Dashboard', canActivate: [accessGuard] },
      { path: 'users', component: UsersPage, title: 'Users', canActivate: [accessGuard] },
      { path: 'profile-fields', canActivate: [accessGuard], component: ProfileFieldsPage, title: 'Profile fields' },
      { path: 'organizations', component: OrganizationsPage, title: 'Organizations', canActivate: [accessGuard, pluginGuard('organizations')] },
      { path: 'applications', component: ApplicationsPage, title: 'Applications', canActivate: [accessGuard, pluginGuard('app-connector')] },
      { path: 'profile-reviews', component: ProfileReviewsPage, title: 'Profile reviews', canActivate: [accessGuard] },
      { path: 'roles', canActivate: [accessGuard], component: RolesAdminPage, title: 'Roles' },
      { path: 'my-profile', component: MyProfilePage, title: 'My profile' },
      { path: 'auth-methods', canActivate: [accessGuard], component: AuthMethodsPage, title: 'Authentication methods' },
      { path: 'assignments', canActivate: [accessGuard], component: AssignmentsPage, title: 'Assignments & changes' },
      { path: 'activation', canActivate: [accessGuard], component: ActivationPage, title: 'Activation' },
      { matcher: pluginsMatcher, canActivate: [accessGuard], component: PluginsPage, title: 'Plugins' },
      { path: 'event-bus', canActivate: [accessGuard], component: BusObserverPage, title: 'Event bus' },
      { path: 'workflows', component: WorkflowsPage, title: 'Workflows', canActivate: [workflowsEnabledGuard] },
      { path: 'workflows/edit/:id', component: WorkflowEditPage, title: 'Workflow editor', canActivate: [workflowsEnabledGuard] },
      { path: 'workflows/run/:id', component: WorkflowRunPage, title: 'Workflow run', canActivate: [workflowsEnabledGuard] },
      { path: 'database', pathMatch: 'full', redirectTo: 'database/branches' },
      { path: 'database/:tab', canActivate: [accessGuard], component: ExplorerPage, title: 'Database (Dolt)' },
    ],
  },
  { path: '**', redirectTo: '' },
];
