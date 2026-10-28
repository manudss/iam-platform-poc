import { Module } from '@nestjs/common';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo } from './builtin/index.js';
import { PluginsAdminController } from './plugins-admin.controller.js';

/**
 * Plugin registry v1 for the demo. State is in memory (settings, enablement, migrations ledger): a restart returns to the base plugins.
 * A PostgreSQL-backed MigrationStore / SettingsStore implements the same interfaces; that is the next step, not done here.
 */
@Module({
  controllers: [PluginsAdminController],
  providers: [{
    provide: PluginRegistry,
    useFactory: () => {
      const r = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), (e) => console.log(`[plugins] ${JSON.stringify(e)}`));
      for (const p of [authPassword, notifyLog, authPasswordLockout(), orgManager, riskGeo]) r.register(p);
      return r;
    },
  }],
  exports: [PluginRegistry],
})
export class PluginsV1Module {}
