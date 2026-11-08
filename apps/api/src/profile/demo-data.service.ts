import { APP_CONNECTOR_DDL, DEMO_APP_CONNECTORS, appConnectorConfig } from '../connectors/app-connector.js';
import { Inject, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { workspaceMode } from '../workspace/context.js';
import { CORE_PROFILE_SETTINGS_ID } from './fields.js';
import { PROFILE_STORE } from './profile.service.js';
import type { ProfileValueStore } from './store.js';

const PASSWORD = 'demo-only-not-a-secret'; // the published fictional demo password, same as demo-alice and demo-bob
const ACCOUNTS = [
  { id: 'camille-martin', display_name: 'Camille Martin', department: 'finance', manager_id: 'demo-alice', email: 'camille.martin@example.invalid', title: 'Chief accountant', phone: '+33 4 72 00 10 01', language: 'fr', grade: 'G5', orgs: ['finance'], roles: ['accountant'] },
  { id: 'hugo-bernard', display_name: 'Hugo Bernard', department: 'finance', manager_id: 'camille-martin', email: 'hugo.bernard@example.invalid', title: 'Payments clerk', phone: '+33 4 72 00 10 02', language: 'fr', grade: 'G3', orgs: ['finance'], roles: ['payment-creator'] },
  { id: 'lea-moreau', display_name: 'Léa Moreau', department: 'finance', manager_id: 'camille-martin', email: 'lea.moreau@example.invalid', title: 'Treasury analyst', phone: '+33 4 72 00 10 03', language: 'en', grade: 'G4', orgs: ['finance'], roles: ['payment-approver'] },
  { id: 'noah-petit', display_name: 'Noah Petit', department: 'it', manager_id: 'demo-alice', email: 'noah.petit@example.invalid', title: 'Platform engineer', phone: '+33 4 72 00 20 01', language: 'en', grade: 'G4', orgs: ['it'], roles: [] },
  { id: 'ines-roux', display_name: 'Inès Roux', department: 'it', manager_id: 'noah-petit', email: 'ines.roux@example.invalid', title: 'Security analyst', phone: '+33 4 72 00 20 02', language: 'fr', grade: 'G3', orgs: ['it', 'security'], roles: [] },
  { id: 'yanis-leroy', display_name: 'Yanis Leroy', department: 'hr', manager_id: 'demo-alice', email: 'yanis.leroy@example.invalid', title: 'HR business partner', phone: '+33 4 72 00 30 01', language: 'fr', grade: 'G4', orgs: ['hr'], roles: [] },
  { id: 'sarah-fontaine', display_name: 'Sarah Fontaine', department: 'sales', manager_id: 'demo-alice', email: 'sarah.fontaine@example.invalid', title: 'Account executive', phone: '+33 4 72 00 40 01', language: 'en', grade: 'G3', orgs: ['sales'], roles: [] },
  { id: 'tom-garnier', display_name: 'Tom Garnier', department: 'sales', manager_id: 'sarah-fontaine', email: 'tom.garnier@example.invalid', title: 'Sales development rep', phone: '+33 4 72 00 40 02', language: 'fr', grade: 'G2', orgs: ['sales'], roles: [] },
];
const ORGS = [
  ['root', 'Acme Demo Company', null], ['finance', 'Finance', 'root'], ['it', 'Information Technology', 'root'], ['security', 'Security Office', 'it'], ['hr', 'Human Resources', 'root'], ['sales', 'Sales', 'root'],
] as const;

/**
 * DEMO ONLY, opt-in with IAM_DEMO_DATA_SEED=1 (the hosted demo sets it). Fills an EMPTY demo so it looks like a living project: the organizations, HR, SSO, MCP and connector plugins enabled,
 * fictional people with logins, organizations and memberships, roles, profile values and a profile configuration. Runs once: it does nothing when organizations already exist
 * on main. Fictional data only (published demo password, example.invalid addresses). Seeded role assignments are data on main; the live permission engine learns them at the next Apply.
 * It never grants an authority field to anyone through a form, never opens anything that an administrator did not see configured.
 */
@Injectable()
export class DemoDataService implements OnApplicationBootstrap {
  constructor(private readonly v: VersioningService, @Optional() private readonly users?: UsersService, @Optional() private readonly branches?: BranchRegistries, @Optional() @Inject(PROFILE_STORE) private readonly store?: ProfileValueStore) {}
  async onApplicationBootstrap() {
    if (process.env.IAM_DEMO_DATA_SEED !== '1' || !workspaceMode() || !this.users || !this.branches || !this.store) return;
    try { await this.seed(process.env.IAM_AUTHN_DEMO_SEED_TENANT || 'acme-demo'); } catch (e) { console.warn('demo data seed skipped:', (e as Error).message); }
  }
  async seed(tenant: string): Promise<boolean> {
    const have = await this.v.at('main', async (c) => {
      const [t] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name='organizations'");
      if (!Number((t as { n: number }[])[0].n)) return false;
      const [r] = await c.query('select count(*) n from organizations where tenant=?', [tenant]); return Number((r as { n: number }[])[0].n) > 0;
    });
    if (have) return false;
    const users = this.users!;
    for (const a of ACCOUNTS) await users.seedAccount(a, PASSWORD);
    await this.v.lock(() => this.v.at('main', async (c) => {
      await c.query('create table if not exists organizations (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, parent_id varchar(32) null, primary key (tenant, id))');
      await c.query('create table if not exists org_memberships (tenant varchar(32) not null, subject varchar(32) not null, org_id varchar(32) not null, primary key (tenant, subject, org_id))');
      for (const [id, name, parent] of ORGS) await c.query('insert ignore into organizations values (?,?,?,?)', [tenant, id, name, parent]);
      for (const [s, o] of [['demo-alice', 'root'], ['demo-bob', 'finance'], ...ACCOUNTS.flatMap((a) => a.orgs.map((o) => [a.id, o]))]) await c.query('insert ignore into org_memberships values (?,?,?)', [tenant, s, o]);
      for (const [id, label, sens] of [['employee', 'Employee (baseline)', false], ['hr-partner', 'HR partner', false], ['security-analyst', 'Security analyst', true], ['sales-rep', 'Sales representative', false]] as const) await c.query('insert ignore into roles values (?,?,?)', [id, label, sens]);
      for (const a of ACCOUNTS) for (const r of a.roles) await c.query('insert ignore into assignments values (?,?)', [a.id, r]);
      await c.query('insert ignore into assignments values (?,?),(?,?),(?,?),(?,?),(?,?)', ['yanis-leroy', 'hr-partner', 'ines-roux', 'security-analyst', 'sarah-fontaine', 'sales-rep', 'demo-alice', 'employee', 'demo-bob', 'employee']);
      await c.query(APP_CONNECTOR_DDL);
      for (const a of DEMO_APP_CONNECTORS) await c.query('insert ignore into app_connectors values (?,?,?,?,?,?,?)', [tenant, a.id, a.name, a.description, a.protocol, a.enabled ? 1 : 0, appConnectorConfig(a)]);
      await c.query("call dolt_add('-A')"); await c.query("call dolt_commit('-m', 'demo seed: organizations, memberships, roles, assignments and applications (fictional)')");
    }));
    const reg = await this.branches!.get('main');
    for (const id of ['organizations', 'hr-attributes', 'workflows-iga', 'app-connector', 'policy-studio', 'oidc-provider', 'saml-idp', 'mcp-gateway', 'csv-connector', 'scim-connector']) { try { await reg.install(tenant, id, {}); } catch { /* already installed */ } try { await reg.enable(tenant, id, id === 'organizations' ? { uiComponents: true } : {}); } catch (e) { console.warn('demo seed: cannot enable', id, (e as Error).message); } }
    // The seeded sign-in chains use TOTP, e-mail code and PIN: their method plugins must be serving (step 2:
    // a method is usable only while its plugin is enabled on the slot).
    for (const id of ['auth-totp', 'auth-email-otp', 'auth-digit-code']) { try { await reg.install(tenant, id, {}); } catch { /* already installed */ } try { await reg.enable(tenant, id, {}); } catch (e) { console.warn('demo seed: cannot enable', id, (e as Error).message); } }
    await (await this.branches!.get('main')).putCoreSettings(tenant, CORE_PROFILE_SETTINGS_ID, { fields: { 'hr-attributes.job_title': { selfEdit: true, signup: 'optional' }, 'hr-attributes.phone': { selfEdit: true }, 'hr-attributes.language': { selfEdit: true, signup: 'optional' } }, signup: { open: true }, selfEditPolicy: 'immediate' });
    for (const a of ACCOUNTS) await this.store!.put(tenant, a.id, { 'hr-attributes.job_title': a.title, 'hr-attributes.phone': a.phone, 'hr-attributes.language': a.language, 'hr-attributes.employee_grade': a.grade }, 'live', 'demo-seed');
    await this.v.lock(() => this.v.at('main', async (c) => {
      for (const [id, name, dept, mail] of [['demo-alice', 'Alice Durand', 'it', 'alice.durand@example.invalid'], ['demo-bob', 'Bob Marchand', 'finance', 'bob.marchand@example.invalid']]) await c.query("update identities set display_name=?, department=?, email=? where id=? and (display_name is null or display_name='')", [name, dept, mail, id]);
      await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('--allow-empty','-m','demo seed: names for the two sign-in accounts')");
    }));
    await this.store!.put(tenant, 'demo-alice', { 'hr-attributes.job_title': 'IAM administrator', 'hr-attributes.language': 'en', 'hr-attributes.employee_grade': 'G6' }, 'live', 'demo-seed');
    await this.store!.put(tenant, 'demo-bob', { 'hr-attributes.job_title': 'Accounts payable officer', 'hr-attributes.language': 'fr', 'hr-attributes.employee_grade': 'G3' }, 'live', 'demo-seed');
    console.log('[demo] demo data seeded (fictional)');
    return true;
  }
}
