import { Module } from '@nestjs/common';
import { PluginRegistry } from './registry.js';
import pg from 'pg';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { PgPluginStore } from './pg-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo } from './builtin/index.js';
import { PluginsAdminController } from './plugins-admin.controller.js';
import { AuthGateController } from './auth-gate.controller.js';

/**
 * Plugin registry v1. With IAM_PG_URL set, settings, enablement, grants, faults and the migration ledger live in PostgreSQL and survive a restart
 * (install migrations really run there). Without it (unit tests, quick local demo) everything is in memory and a restart returns to the base plugins.
 */
@Module({
  controllers: [PluginsAdminController, AuthGateController],
  providers: [{
    provide: PluginRegistry,
    useFactory: async () => {
      const audit = (e: unknown) => console.log(`[plugins] ${JSON.stringify(e)}`);
      const url = process.env.IAM_PG_URL;
      const pgs = url ? new PgPluginStore(new pg.Pool({ connectionString: url, max: 2 })) : undefined;
      const r = pgs ? new PluginRegistry(pgs, pgs, audit, pgs) : new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), audit, new MemoryStateStore());
      for (const p of [authPassword, notifyLog, authPasswordLockout(), orgManager, riskGeo]) r.register(p);
      await r.load();
      return r;
    },
  }],
  exports: [PluginRegistry],
})
export class PluginsV1Module {}
