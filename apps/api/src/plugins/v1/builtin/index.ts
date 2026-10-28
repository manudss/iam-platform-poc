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
export function authPasswordLockout(failures: Map<string, number> = new Map()): PluginImpl {
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
      'auth.authenticate': (p: AuthenticatePayload, c): AuthenticateResult => {
        const n = failures.get(p.subject) ?? 0;
        if (n >= (c.settings.maxFailures as number)) return { outcome: 'deny', reason: 'locked' };
        const ok = authPassword.handlers['auth.authenticate'](p, c) as AuthenticateResult;
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
