/**
 * app-connector plugin: the declaration of a third-party application (service provider / relying party)
 * that signs in through this platform acting as the identity provider, in OIDC or SAML. All validation and
 * registry logic lives in this folder; the core adapter only owns the storage wiring (Dolt/memory store)
 * and feeds `createAppRegistry(deps)` its dependencies.
 *
 * Configuration lives in Dolt (on a branch, reviewable, mergeable). Secrets never live here: `secret_ref`
 * is only the name of an entry in the secret store.
 *
 * deps = {
 *   pluginActive(tenant, id, ref) -> boolean ('work' for the admin API, 'live' for the protocol plugins)
 *   store: { list(tenant, ref), write(tenant, actor, fn) }  -> the core storage adapter
 *   emit(type, tenant, payload)  -> durable audit event
 *   branch()                     -> current workspace branch, for the audit event
 * }
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException, ConflictException, NotFoundException } = require('@nestjs/common');

export const APP_CONNECTOR_PLUGIN = 'app-connector';
export const APP_CONNECTOR_DDL = 'create table if not exists app_connectors (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, description varchar(240) not null, protocol varchar(8) not null, enabled tinyint not null, config longtext not null, primary key (tenant, id))';

export const appConnectorConfig = (a) => JSON.stringify({ redirect_uris: a.redirect_uris, entity_id: a.entity_id, acs_url: a.acs_url, attribute_mapping: a.attribute_mapping, allowed_roles: a.allowed_roles, secret_ref: a.secret_ref });

const ID = /^[a-z0-9-]{1,32}$/, KEY = /^[A-Za-z0-9_.:-]{1,64}$/, REF = /^[a-z0-9][a-z0-9/_.-]{0,63}$/;
const FORBIDDEN = ['secret', 'client_secret', 'private_key', 'password', 'token'];
/** Exact https URL, or http only on localhost (local tests). No wildcard, no fragment, no credentials in the URL. */
export function checkUrl(v, what) {
  if (typeof v !== 'string' || v.length > 300) throw new BadRequestException(`${what}: a URL of at most 300 characters`);
  let u; try { u = new URL(v); } catch { throw new BadRequestException(`${what}: not a valid URL`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new BadRequestException(`${what}: https is required (http only for localhost)`);
  if (v.includes('*') || u.hash || u.username || u.password) throw new BadRequestException(`${what}: no wildcard, fragment or credentials`);
  return v;
}
const strs = (v, what, max) => { if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string')) throw new BadRequestException(`${what}: a list of at most ${max} strings`); return [...new Set(v)]; };

/** Validates a full or partial body and returns the new connector. `base` is the existing one for a partial update. */
export function build(id, b, base) {
  for (const k of Object.keys(b ?? {})) if (FORBIDDEN.includes(k.toLowerCase())) throw new BadRequestException(`${k}: secrets are never stored here; save it in the secret store and give its name in secret_ref`);
  const a = base ? structuredClone(base) : { id, name: '', description: '', protocol: 'oidc', enabled: false, redirect_uris: [], entity_id: null, acs_url: null, attribute_mapping: {}, allowed_roles: [], secret_ref: null };
  if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters'); a.name = b.name.trim(); }
  if (b.description !== undefined) { if (typeof b.description !== 'string' || b.description.length > 240) throw new BadRequestException('description: at most 240 characters'); a.description = b.description; }
  if (b.protocol !== undefined) { if (b.protocol !== 'oidc' && b.protocol !== 'saml') throw new BadRequestException("protocol: 'oidc' or 'saml'"); a.protocol = b.protocol; }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new BadRequestException('enabled: true or false'); a.enabled = b.enabled; }
  if (b.redirect_uris !== undefined) a.redirect_uris = strs(b.redirect_uris, 'redirect_uris', 10).map((u) => checkUrl(u, 'redirect_uris'));
  if (b.entity_id !== undefined) a.entity_id = b.entity_id === null || b.entity_id === '' ? null : (typeof b.entity_id === 'string' && b.entity_id.length <= 300 ? b.entity_id : (() => { throw new BadRequestException('entity_id: at most 300 characters'); })());
  if (b.acs_url !== undefined) a.acs_url = b.acs_url === null || b.acs_url === '' ? null : checkUrl(b.acs_url, 'acs_url');
  if (b.attribute_mapping !== undefined) {
    const m = b.attribute_mapping;
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length > 30) throw new BadRequestException('attribute_mapping: an object of at most 30 entries');
    for (const [k, v] of Object.entries(m)) if (!KEY.test(k) || typeof v !== 'string' || !KEY.test(v)) throw new BadRequestException(`attribute_mapping.${k}: names use letters, digits and _ . : -`);
    a.attribute_mapping = m;
  }
  if (b.allowed_roles !== undefined) a.allowed_roles = strs(b.allowed_roles, 'allowed_roles', 50).map((r) => { if (!ID.test(r)) throw new BadRequestException(`allowed_roles: invalid role id ${r}`); return r; });
  if (b.secret_ref !== undefined) { if (b.secret_ref === null || b.secret_ref === '') a.secret_ref = null; else if (typeof b.secret_ref === 'string' && REF.test(b.secret_ref)) a.secret_ref = b.secret_ref; else throw new BadRequestException('secret_ref: the name of a secret in the secret store (lowercase letters, digits, / _ . -)'); }
  if (!a.name) throw new BadRequestException('name is required');
  if (a.protocol === 'oidc' && a.redirect_uris.length === 0) throw new BadRequestException('redirect_uris: at least one for an OIDC application');
  if (a.protocol === 'saml' && (!a.entity_id || !a.acs_url)) throw new BadRequestException('entity_id and acs_url are required for a SAML application');
  if (a.protocol === 'oidc') { a.entity_id = null; a.acs_url = null; } else a.redirect_uris = [];
  return a;
}

/** The registry: admin CRUD on the working branch, live reads for the protocol plugins. */
export function createAppRegistry(deps) {
  const need = async (t) => { if (!(await deps.pluginActive(t, APP_CONNECTOR_PLUGIN, 'work'))) throw new NotFoundException('the app-connector plugin is not enabled'); };
  const emit = (type, t, a, actor) => deps.emit(type, t, { app: a.id, protocol: a.protocol, actor });
  const api = {
    async list(t) { await need(t); return deps.store.list(t, 'work'); },
    /** Applications as they are LIVE (Dolt main): what the protocol plugins serve. Empty while the plugin is off. */
    async liveApps(t) { if (!(await deps.pluginActive(t, APP_CONNECTOR_PLUGIN, 'live'))) return []; return (await deps.store.list(t, 'live')).apps; },
    async get(t, id) { await need(t); const a = (await deps.store.list(t, 'work')).apps.find((x) => x.id === id); if (!a) throw new NotFoundException('unknown application'); return a; },
    async create(t, actor, b) {
      await need(t);
      if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
      const a = build(b.id, b); let ok = false;
      await deps.store.write(t, actor, (s) => { if (s.apps.some((x) => x.id === a.id)) throw new ConflictException('application already exists'); s.apps.push(a); ok = true; });
      if (ok) emit('app.registered', t, a, actor);
      return a;
    },
    async update(t, actor, id, b) {
      await need(t); let out;
      await deps.store.write(t, actor, (s) => { const i = s.apps.findIndex((x) => x.id === id); if (i < 0) throw new NotFoundException('unknown application'); out = build(id, b ?? {}, s.apps[i]); s.apps[i] = out; });
      emit('app.updated', t, out, actor);
      return out;
    },
    async remove(t, actor, id) {
      await need(t); let gone;
      await deps.store.write(t, actor, (s) => { const a = s.apps.find((x) => x.id === id); if (!a) throw new NotFoundException('unknown application'); if (a.enabled) throw new ConflictException('disable the application before deleting it'); gone = a; s.apps = s.apps.filter((x) => x.id !== id); });
      emit('app.removed', t, gone, actor);
      return api.list(t);
    },
  };
  return api;
}

/** Fictional applications for the seeded demo (seed scripts only: the project installs empty). */
export const DEMO_APP_CONNECTORS = [
  { id: 'wiki', name: 'Company wiki', description: 'Internal knowledge base (fictional). Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['https://wiki.example.invalid/auth/callback', 'http://localhost:4300/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name' }, allowed_roles: ['employee'], secret_ref: 'apps/wiki/client-secret' },
  { id: 'payroll', name: 'Payroll', description: 'Payroll portal (fictional). Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://payroll.example.invalid/saml/metadata', acs_url: 'https://payroll.example.invalid/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', department: 'department' }, allowed_roles: ['hr-partner'], secret_ref: 'apps/payroll/signing-key' },
  { id: 'crm', name: 'Sales CRM', description: 'Customer relationship tool (fictional). Signs in with OpenID Connect; still being set up, so disabled.', protocol: 'oidc', enabled: false,
    redirect_uris: ['https://crm.example.invalid/oauth/callback', 'http://localhost:4300/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', groups: 'roles' }, allowed_roles: ['sales-rep'], secret_ref: 'apps/crm/client-secret' },

// The ten fictional business applications of the iam-demo-apps gallery (separate repository).
// SAML apps live on their own subdomain of apps.dss.name (wildcard CNAME -> iam-demo-apps.onrender.com).
  { id: 'peoplehub', name: 'PeopleHub', description: 'HR portal (fictional): directory, time off, org chart. Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['http://localhost:3000/peoplehub/auth/callback', 'https://iam-demo-apps.onrender.com/peoplehub/auth/callback', 'https://peoplehub.apps.dss.name/auth/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', department: 'department', roles: 'roles' }, allowed_roles: ['hr-viewer', 'hr-manager'], secret_ref: 'apps/peoplehub/client-secret' },
  { id: 'expenseflow', name: 'ExpenseFlow', description: 'Expense reports (fictional): submit, approve, track. Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://expenseflow.apps.dss.name/saml/metadata', acs_url: 'https://expenseflow.apps.dss.name/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', email: 'email', department: 'department', roles: 'roles' }, allowed_roles: ['expense-user', 'expense-approver'], secret_ref: 'apps/expenseflow/signing-key' },
  { id: 'clientdesk', name: 'ClientDesk', description: 'CRM (fictional): accounts, opportunities, pipeline. Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['http://localhost:3000/clientdesk/auth/callback', 'https://iam-demo-apps.onrender.com/clientdesk/auth/callback', 'https://clientdesk.apps.dss.name/auth/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', department: 'department', roles: 'roles' }, allowed_roles: ['sales', 'sales-manager'], secret_ref: 'apps/clientdesk/client-secret' },
  { id: 'ticketly', name: 'Ticketly', description: 'Support (fictional): tickets, queues, assignment. Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://ticketly.apps.dss.name/saml/metadata', acs_url: 'https://ticketly.apps.dss.name/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', email: 'email', department: 'department', roles: 'roles' }, allowed_roles: ['ticket-user', 'ticket-agent'], secret_ref: 'apps/ticketly/signing-key' },
  { id: 'stockroom', name: 'StockRoom', description: 'Inventory (fictional): stock, supplier orders. Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['http://localhost:3000/stockroom/auth/callback', 'https://iam-demo-apps.onrender.com/stockroom/auth/callback', 'https://stockroom.apps.dss.name/auth/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', department: 'department', roles: 'roles' }, allowed_roles: ['stock-viewer', 'stock-manager'], secret_ref: 'apps/stockroom/client-secret' },
  { id: 'timesheet', name: 'TimeSheet', description: 'Time tracking (fictional): log, approve, report. Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://timesheet.apps.dss.name/saml/metadata', acs_url: 'https://timesheet.apps.dss.name/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', email: 'email', department: 'department', roles: 'roles' }, allowed_roles: ['time-user', 'time-approver'], secret_ref: 'apps/timesheet/signing-key' },
  { id: 'learnup', name: 'LearnUp', description: 'Training (fictional): catalogue, enrolment, progress. Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['http://localhost:3000/learnup/auth/callback', 'https://iam-demo-apps.onrender.com/learnup/auth/callback', 'https://learnup.apps.dss.name/auth/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', department: 'department', roles: 'roles' }, allowed_roles: ['learner', 'trainer'], secret_ref: 'apps/learnup/client-secret' },
  { id: 'travelops', name: 'TravelOps', description: 'Travel (fictional): requests, approval, booking. Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://travelops.apps.dss.name/saml/metadata', acs_url: 'https://travelops.apps.dss.name/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', email: 'email', department: 'department', roles: 'roles' }, allowed_roles: ['traveler', 'travel-approver'], secret_ref: 'apps/travelops/signing-key' },
  { id: 'sso-config-oidc', name: 'SSO Config: OIDC', description: 'Guided OpenID Connect configuration (fictional): discovery, endpoints, test sign-in. Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['http://localhost:3000/sso-config-oidc/auth/callback', 'https://iam-demo-apps.onrender.com/sso-config-oidc/auth/callback', 'https://sso-config-oidc.apps.dss.name/auth/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', department: 'department', roles: 'roles' }, allowed_roles: ['employee'], secret_ref: 'apps/sso-config-oidc/client-secret' },
  { id: 'sso-config-saml', name: 'SSO Config: SAML', description: 'Guided SAML 2.0 configuration (fictional): IdP/SP metadata, attribute mapping, test sign-in. Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://sso-config-saml.apps.dss.name/saml/metadata', acs_url: 'https://sso-config-saml.apps.dss.name/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', email: 'email', department: 'department', roles: 'roles' }, allowed_roles: ['employee'], secret_ref: 'apps/sso-config-saml/signing-key' },
];

// No bus hooks: the plugin serves its registry through the engine the core adapter wires.
export default {};
