import { Routes, UrlMatcher, UrlSegment } from '@angular/router';
import { authGuard } from './auth';
import { CallbackPage, LoginPage } from './login';
import { ActivationPage, ExplorerPage, OverviewPage, PluginsPage } from './pages';
import { AssignmentsPage } from './assignments';
import { UsersPage } from './users';
import { SignupPage } from './signup-page';
import { PrivacyPage } from './privacy-page';
import { AboutPage } from './about-page';
import { SsoInteractionPage } from './sso-interaction';
import { SsoSamlPage } from './sso-saml';
import { workflowsEnabledGuard } from './workflows/guard';
import { accessGuard, pluginGuard } from './access';
import { Shell } from './shell';
import { ReviewPage } from './review';
import { PluginScreenPage } from './plugin-screen';

/** /plugins and /plugins/:id share one route (and so one component instance): selecting a plugin only updates the address. */
export const pluginsMatcher: UrlMatcher = (segs: UrlSegment[]) =>
  segs[0]?.path === 'plugins' && segs.length <= 2 ? { consumed: segs, posParams: segs[1] ? { id: segs[1] } as Record<string, UrlSegment> : ({} as Record<string, UrlSegment>) } : null;

export const routes: Routes = [
  { path: 'callback', component: CallbackPage },
  { path: 'sso-interaction/:uid', component: SsoInteractionPage, canActivate: [authGuard], title: 'Sign in to an application' },
  { path: 'sso-saml/:rid', component: SsoSamlPage, canActivate: [authGuard], title: 'Sign in to an application' },
  { path: 'signup', component: SignupPage, title: 'Request an account' },
  { path: 'privacy', component: PrivacyPage, title: 'Politique de confidentialité' },
  { path: 'about', component: AboutPage, title: 'About this demo' },
  { path: 'login', component: LoginPage, title: 'Sign in' },
  // Static console mock for the Customisation live preview (no session, no data; the parent frame posts the draft theme).
  { path: 'admin-preview', loadComponent: () => import('./admin-preview').then(m => m.AdminPreviewPage), title: 'Console preview' },
  {
    path: '', component: Shell, canActivate: [authGuard], children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', component: OverviewPage, title: 'Dashboard', canActivate: [accessGuard] },
      { path: 'users', component: UsersPage, title: 'Users', canActivate: [accessGuard] },
      { path: 'profile-fields', canActivate: [accessGuard], loadComponent: () => import('./profile-fields').then(m => m.ProfileFieldsPage), title: 'Profile fields' },
      { path: 'applications', loadComponent: () => import('./applications').then(m => m.ApplicationsPage), title: 'Applications', canActivate: [accessGuard, pluginGuard('app-connector')] },
      { path: 'policies', loadComponent: () => import('./policies').then(m => m.PoliciesPage), title: 'Policies', canActivate: [accessGuard, pluginGuard('policy-studio')] },
      { path: 'profile-reviews', loadComponent: () => import('./profile-reviews').then(m => m.ProfileReviewsPage), title: 'Profile reviews', canActivate: [accessGuard] },
      { path: 'roles', canActivate: [accessGuard], loadComponent: () => import('./roles-admin').then(m => m.RolesAdminPage), title: 'Roles' },
      { path: 'access-denied', loadComponent: () => import('./access-denied').then(m => m.AccessDeniedPage), title: 'Access denied' },
      { path: 'my-profile', loadComponent: () => import('./my-profile').then(m => m.MyProfilePage), title: 'My profile' },
      { path: 'auth-methods', canActivate: [accessGuard], loadComponent: () => import('./auth-methods').then(m => m.AuthMethodsPage), title: 'Authentication methods' },
      { path: 'assignments/matrix', canActivate: [accessGuard], loadComponent: () => import('./assignment-matrix').then(m => m.AssignmentMatrixPage), title: 'Bulk assignments' },
      { path: 'assignments', canActivate: [accessGuard], component: AssignmentsPage, title: 'Assignments & changes' },
      { path: 'activation', canActivate: [accessGuard], component: ActivationPage, title: 'Activation' },
      { matcher: pluginsMatcher, canActivate: [accessGuard], component: PluginsPage, title: 'Plugins' },
      { path: 'event-bus', canActivate: [accessGuard], loadComponent: () => import('./bus-observer').then(m => m.BusObserverPage), title: 'Event bus' },
      { path: 'mcp', canActivate: [accessGuard], loadComponent: () => import('./mcp').then(m => m.McpPage), title: 'MCP (AI access)' },
      { path: 'workflows', loadComponent: () => import('./workflows').then(m => m.WorkflowsPage), title: 'Workflows', canActivate: [workflowsEnabledGuard] },
      { path: 'workflows/edit/:id', loadComponent: () => import('./workflows').then(m => m.WorkflowEditPage), title: 'Workflow editor', canActivate: [workflowsEnabledGuard] },
      { path: 'workflows/runs', loadComponent: () => import('./workflows').then(m => m.WorkflowExecutionsPage), title: 'Workflow executions', canActivate: [workflowsEnabledGuard] },
      { path: 'workflows/run/:id', loadComponent: () => import('./workflows').then(m => m.WorkflowRunPage), title: 'Workflow run', canActivate: [workflowsEnabledGuard] },
      { path: 'database', pathMatch: 'full', redirectTo: 'database/home' },
      { path: 'review', canActivate: [accessGuard], component: ReviewPage, title: 'Review changes' },
      { path: 'database/:tab', canActivate: [accessGuard], component: ExplorerPage, title: 'Database (Dolt)' },
      // Packaged plugin screens (constat 4): one generic route; the host reads the tenant's screen inventory and
      // imports the plugin's own module, so a plugin adds/removes its screen with no apps/web change.
      { path: 'screens/:plugin/:screen', canActivate: [accessGuard], component: PluginScreenPage, title: 'Plugin screen' },
    ],
  },
  { path: '**', redirectTo: '' },
];
