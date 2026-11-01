import { BranchRegistries } from './branch-registries.js';
import { DoltPluginStore } from './dolt-stores.js';
import { VersioningModule } from '../../versioning/versioning.module.js';
import { VersioningService } from '../../versioning/versioning.service.js';
import { UsersModule } from '../../users/users.module.js';
import { UsersService } from '../../users/users.service.js';
import { Module } from '@nestjs/common';
import { PluginRegistry } from './registry.js';
import pg from 'pg';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { PgPluginStore } from './pg-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo, hrAttributes, organizations, hooksJournal } from './builtin/index.js';
import { JournalController } from '../../journal/journal.controller.js';
import { PluginsAdminController } from './plugins-admin.controller.js';
import { AuthGateController } from './auth-gate.controller.js';
import { ProfileService, PROFILE_STORE, SIGNUP_ALLOWED, defaultSignupAllowed } from '../../profile/profile.service.js';
import { SignupService } from '../../profile/signup.service.js';
import { SignupController } from '../../profile/signup.controller.js';
import { OrgController, OrgService, ORG_STORE, DoltOrgStore, MemoryOrgStore } from '../../profile/orgs.js';
import { RolesController, RolesService } from '../../profile/roles.js';
import { ProfileController } from '../../profile/profile.controller.js';
import { DoltProfileStore, MemoryProfileStore } from '../../profile/store.js';
import { currentBranch } from '../../workspace/context.js';
import { DemoDataService } from '../../profile/demo-data.service.js';
import { SigninOptionsController } from '../../authn/signin-options.controller.js';
import { AuthnService } from '../../authn/flow.service.js';
import { AuthnAdminController } from '../../authn/authn.controller.js';

/**
 * Plugin registry v1. With IAM_PG_URL set, settings, enablement, grants, faults and the migration ledger live in PostgreSQL and survive a restart
 * (install migrations really run there). Without it (unit tests, quick local demo) everything is in memory and a restart returns to the base plugins.
 */
@Module({
  imports: [VersioningModule, UsersModule],
  controllers: [JournalController, PluginsAdminController, AuthGateController, AuthnAdminController, ProfileController, SignupController, OrgController, RolesController, SigninOptionsController],
  providers: [{ provide: SIGNUP_ALLOWED, useValue: defaultSignupAllowed }, BranchRegistries, AuthnService, DemoDataService, ProfileService, SignupService, OrgService, RolesService, {
    provide: ORG_STORE,
    inject: [VersioningService],
    useFactory: (v: VersioningService) => process.env.IAM_WORKSPACE_MODE === '1' || process.env.IAM_PLUGIN_STORE === 'dolt' ? new DoltOrgStore(v, (w) => currentBranch(w)) : new MemoryOrgStore(),
  }, {
    provide: PROFILE_STORE,
    inject: [VersioningService],
    useFactory: (v: VersioningService) => process.env.IAM_WORKSPACE_MODE === '1' || process.env.IAM_PLUGIN_STORE === 'dolt' ? new DoltProfileStore(v, (w) => currentBranch(w)) : new MemoryProfileStore(),
  }, {
    provide: PluginRegistry,
    inject: [VersioningService, UsersService, BranchRegistries],
    useFactory: async (v: VersioningService, users: UsersService, branches: BranchRegistries) => {
      if (process.env.IAM_WORKSPACE_MODE === '1') return branches.get('main');
      const audit = (e: unknown) => console.log(`[plugins] ${JSON.stringify(e)}`);
      const url = process.env.IAM_PG_URL;
      const pgs = url ? new PgPluginStore(new pg.Pool({ connectionString: url, max: 2 })) : undefined;
      const ds = process.env.IAM_PLUGIN_STORE === 'dolt' ? new DoltPluginStore(v) : undefined;
      const r = ds ? new PluginRegistry(ds, ds, audit, ds) : pgs ? new PluginRegistry(pgs, pgs, audit, pgs) : new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), audit, new MemoryStateStore());
      const base = process.env.IAM_DIRECTORY_AUTH === '1' ? { ...authPassword, handlers: { 'auth.authenticate': async (p: any) => (await users.authenticate(p.tenant, p.subject, p.credential.password)) ? { outcome: 'allow', subject: p.subject, methods: ['pwd'] } : { outcome: 'deny', reason: 'bad-credentials' } } } : authPassword;
      for (const p of [base, notifyLog, authPasswordLockout(new Map(), base), orgManager, riskGeo, hrAttributes, organizations, hooksJournal]) {
        if (ds && p.manifest.settings.some(f => f.type === 'secret')) throw new Error('Dolt plugin store refuses secret settings; use a secret store');
        r.register(p);
      }
      await r.load();
      return r;
    },
  }],
  exports: [PluginRegistry, BranchRegistries, AuthnService],
})
export class PluginsV1Module {}
