import type { PluginImpl } from '../registry.js';
import type { AuthenticatePayload, AuthenticateResult, NotifyPayload } from '../hooks.js';

/** Demo credential store: fictional users only. */
const DEMO_USERS: Record<string, string> = { 'demo-user-1': 'demo-pass-1', 'demo-admin': 'demo-pass-admin', 'demo-alice': 'demo-only-not-a-secret', 'demo-bob': 'demo-only-not-a-secret' };

// ---------- Base plugins (mandatory for their slot) ----------

export const authPassword: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'auth-password', version: '1.0.0', name: 'Password sign-in (base)', publisher: 'iam-platform',
    kinds: ['auth-method'], base: true, provides: ['auth.password'],
    hooks: [{ name: 'auth.authenticate', mode: 'blocking' }],
    settings: [
      { key: 'minLength', type: 'number', label: 'Minimum password length', default: 12, min: 8, max: 128, group: 'Policy' },
      { key: 'allowedDomains', type: 'list', label: 'Allowed e-mail domains (empty = all)', default: [], group: 'Policy' },
    ],
  },
  handlers: {
    'auth.authenticate': (p: AuthenticatePayload): AuthenticateResult =>
      DEMO_USERS[p.subject] !== undefined && DEMO_USERS[p.subject] === p.credential.password
        ? { outcome: 'allow', subject: p.subject, methods: ['pwd'] }
        : { outcome: 'deny', reason: 'bad-credentials' },
  },
};

export const notifyLog: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'notify-log', version: '1.0.0', name: 'Notifications to the log (base)', publisher: 'iam-platform',
    kinds: ['notifier'], base: true, provides: ['notify.default'],
    hooks: [{ name: 'notify.send', mode: 'async' }],
    settings: [{ key: 'prefix', type: 'string', label: 'Log prefix', default: 'notify', group: 'General' }],
  },
  handlers: { 'notify.send': (p: NotifyPayload, c) => ({ delivered: false, line: `${c.settings.prefix}: ${p.template} -> ${p.to}` }) },
};

// ---------- Replacements: extend a base, same settings and hooks, may add more ----------

/** Same checks as the base, plus a lockout after repeated failures. Keeps every base setting. */
export function authPasswordLockout(failures: Map<string, number> = new Map(), base: PluginImpl = authPassword): PluginImpl {
  return {
    manifest: {
      apiVersion: 'plugin/v1', id: 'auth-password-lockout', version: '1.0.0', name: 'Password sign-in with lockout', publisher: 'iam-platform',
      kinds: ['auth-method'], extends: 'auth-password', provides: ['auth.password'],
      hooks: [{ name: 'auth.authenticate', mode: 'blocking' }],
      install: { migrations: [{ id: '001-attempts', sql: ['create table if not exists plg_auth_password_lockout_attempts (tenant text not null, subject text not null, failures int not null default 0, locked_until timestamptz, primary key (tenant, subject))'] }] },
      settings: [
        { key: 'minLength', type: 'number', label: 'Minimum password length', default: 12, min: 8, max: 128, group: 'Policy' },
        { key: 'allowedDomains', type: 'list', label: 'Allowed e-mail domains (empty = all)', default: [], group: 'Policy' },
        { key: 'maxFailures', type: 'number', label: 'Failures before lockout', default: 5, min: 1, max: 50, group: 'Lockout' },
      ],
    },
    handlers: {
      'auth.authenticate': async (p: AuthenticatePayload, c): Promise<AuthenticateResult> => {
        const n = failures.get(p.subject) ?? 0;
        if (n >= (c.settings.maxFailures as number)) return { outcome: 'deny', reason: 'locked' };
        const ok = await base.handlers['auth.authenticate'](p, c) as AuthenticateResult;
        if (ok.outcome === 'deny') failures.set(p.subject, n + 1); else failures.delete(p.subject);
        return ok;
      },
    },
  };
}

/** A multi-kind example: organizations. Profile enrichment (async + blocking), a workflow step and two schema-rendered screens. */
export const orgManager: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'org-manager', version: '1.0.0', name: 'Organizations', publisher: 'iam-platform',
    kinds: ['profile', 'workflow', 'ui'],
    hooks: [{ name: 'profile.enrich', mode: 'blocking' }, { name: 'identity.changed', mode: 'async' }],
    install: {
      migrations: [{ id: '001-orgs', sql: ['create table if not exists plg_org_manager_orgs (tenant text not null, id text not null, parent text, name text not null, primary key (tenant, id))', 'create table if not exists plg_org_manager_members (tenant text not null, org text not null, subject text not null, primary key (tenant, org, subject))'] }],
      seed: [{ table: 'plg_org_manager_orgs', row: { id: 'root', name: 'Demo company' } }],
    },
    settings: [
      { key: 'maxDepth', type: 'number', label: 'Maximum hierarchy depth', default: 5, min: 1, max: 12, group: 'General' },
      { key: 'claimName', type: 'string', label: 'Claim that carries the organization', default: 'org', pattern: '^[a-z_]+$', group: 'Claims' },
    ],
    screens: [
      { id: 'orgs', title: 'Organizations', area: 'admin', render: 'schema', schemaRef: 'plg_org_manager_orgs' },
      { id: 'members', title: 'Members', area: 'admin', render: 'schema', schemaRef: 'plg_org_manager_members' },
    ],
  },
  handlers: {
    'profile.enrich': (p, c) => ({ ...p.profile, [c.settings.claimName as string]: 'root' }),
    'identity.changed': (p) => ({ queued: p.effectKey }),
  },
};

/** Example that asks for more than it is given: component screen and a sensitive hook. Used to show the grant boundary. */
export const riskGeo: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'risk-geo', version: '0.1.0', name: 'Geo-velocity risk signal', publisher: 'example',
    kinds: ['risk-signal', 'ui'], hooks: [{ name: 'risk.score', mode: 'blocking' }],
    settings: [{ key: 'maxKmPerHour', type: 'number', label: 'Impossible travel speed (km/h)', default: 900, min: 100, max: 3000 }],
    screens: [{ id: 'map', title: 'Sign-in map', area: 'admin', render: 'component', component: 'risk-geo-map' }],
  },
  handlers: { 'risk.score': () => ({ score: 10 }) },
};

/** Example profile plugin: fictional HR attributes. Shipped disabled; an admin enables it, then configures each field. Its authority field shows that the user can never edit it. */
export const hrAttributes: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'hr-attributes', version: '1.0.0', name: 'HR attributes (example)', publisher: 'iam-platform',
    kinds: ['profile'], hooks: [], settings: [],
    profileFields: [
      { key: 'job_title', type: 'string', label: 'Job title', max: 60, pii: 'none', defaults: { selfEdit: true, signup: 'optional' } },
      { key: 'phone', type: 'phone', label: 'Phone', pii: 'personal', defaults: { selfEdit: true } },
      { key: 'language', type: 'select', label: 'Language', pii: 'none', options: [{ value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }], defaults: { selfEdit: true, signup: 'optional' } },
      { key: 'employee_grade', type: 'string', label: 'Grade', max: 20, klass: 'authority', pii: 'none', help: 'Read by access decisions: only an administrator can set it.' },
    ],
  },
  handlers: {},
};

/** Example profile plugin: organizations. It adds screens (organizations CRUD, memberships) and a read-only section on the profile. Membership is an assignment by an administrator, never a profile field. */
export const organizations: PluginImpl = {
  manifest: { apiVersion: 'plugin/v1', id: 'organizations', version: '1.0.0', name: 'Organizations (example)', publisher: 'iam-platform', kinds: ['profile'], hooks: [], settings: [] },
  handlers: {},
};
/**
 * Feature gate for the IGA workflows module (editor, runs, tracking): the feature exists only while this plugin
 * is enabled for the tenant. While disabled, the console hides the Workflows menu and every /workflows* endpoint
 * answers 403. A run already executing when the plugin is disabled is left to finish (its data stays on its own
 * Dolt branch; publishing to main always stays a human merge); retry/cancel/review are refused until re-enabled.
 */
export const workflowsIga: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'workflows-iga', version: '0.1.0', name: 'Workflows (IGA)', publisher: 'iam-platform',
    kinds: ['workflow', 'ui'],
    description: 'Visual IGA workflow scenarios: build a graph of steps, run it, follow every step. Simulated steps (wait, notification, deliberate failure) never have an external effect; real data steps write on the run\'s own Dolt branch, merged by a human review.',
    hooks: [],
    settings: [],
    screens: [{ id: 'workflows', title: 'Workflows', area: 'admin', render: 'schema' }],
  },
  handlers: {},
};

/**
 * Declares third-party applications (service providers) that will sign in through this platform acting as the identity provider (OIDC or SAML).
 * This plugin only holds the configuration, in Dolt, on a branch: the OIDC and SAML protocol plugins come in later steps and read this registry.
 * While disabled, the Applications menu is hidden and every /app-connectors endpoint answers 404. Secrets are never stored: only a reference to the secret store.
 */
export const appConnector: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'app-connector', version: '0.1.0', name: 'Application connectors (SSO)', publisher: 'iam-platform',
    kinds: ['connector', 'ui'],
    description: 'Register the applications that sign in through this platform (OIDC or SAML): redirect URIs, attribute mapping, allowed roles. Configuration only for now; the protocols come as separate plugins.',
    hooks: [],
    settings: [],
    screens: [{ id: 'applications', title: 'Applications', area: 'admin', render: 'schema' }],
  },
  handlers: {},
};

/**
 * Policy studio: see the Cedar rules the core decides with. Step 1 is read-only: a catalogue (name, effect, grouping, plain-language reading,
 * Cedar text, how often recent decisions used it). Editing, validation, simulation and impact analysis come in later steps; the plugin never changes
 * a rule or a decision. While disabled, the Policies menu is hidden and every /policies endpoint answers 404.
 */
export const policyStudio: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'policy-studio', version: '0.1.0', name: 'Policy studio (Cedar rules)', publisher: 'iam-platform',
    kinds: ['ui'],
    description: 'View the access rules (Cedar) the core decides with: names, effect, plain-language reading, and how often recent decisions used each. Read-only for now.',
    hooks: [],
    settings: [],
    screens: [{ id: 'policies', title: 'Policies', area: 'admin', render: 'schema' }],
  },
  handlers: {},
};

/**
 * OpenID Connect provider (step 2 of the SSO plan): the platform acts as the OpenID Provider for the applications of `app-connector`
 * (discovery, authorize with PKCE, token, userinfo, JWKS, refresh, logout) through the embedded library node-oidc-provider. Turning the plugin
 * off removes every /sso/:tenant/oidc endpoint (404) without touching the application registry.
 */
export const oidcProvider: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'oidc-provider', version: '0.1.0', name: 'OpenID Connect provider (SSO)', publisher: 'iam-platform',
    kinds: ['connector'],
    description: 'Lets the registered applications sign in with OpenID Connect (authorization code + PKCE). Access follows the application allowed roles; the user signs in with the normal authentication chain and consents.',
    requires: ['app-connector'],
    hooks: [],
    settings: [],
  },
  handlers: {},
};
