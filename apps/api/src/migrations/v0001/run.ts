import type { INestApplication } from '@nestjs/common';
import { AuthnService } from '../../authn/flow.service.js';
import { DemoDataService } from './demo-data.service.js';
import { WorkflowDemoSeed, SEEDS } from './workflow-seed.js';
import { WorkflowStore } from '../../workflows/store.js';
import type { MigrationJournal } from '../journal.js';
export function initialMigration(app: INestApplication, journal: MigrationJournal, bootId: string, tenant: string) { return {
    id: '0001',
    run: async () => {
      const state = journal.assertBoot(bootId);
      if (state.pending?.phase !== 'initial-api') throw new Error('baseline requires completed initial-schema phase');
      // Fresh preview only. An adopted Oracle baseline never enters any of these seed methods.
      journal.phase(bootId, 'initial-authn');
      if (!await app.get(AuthnService).seedDemo(tenant)) throw new Error('unexpected existing authentication during fresh baseline');
      journal.phase(bootId, 'initial-demo-data');
      if (!await app.get(DemoDataService, { strict: false }).seed(tenant)) throw new Error('unexpected existing demo data during fresh baseline');
      journal.phase(bootId, 'initial-workflows');
      await app.get(WorkflowDemoSeed, { strict: false }).seed(tenant);
    },
    verify: async () => {
      const auth = await app.get(AuthnService).liveConfig(tenant);
      if (!auth.methods.length || !auth.chains.length) throw new Error('initial auth configuration missing');
      const workflows = app.get(WorkflowStore, { strict: false });
      for (const seed of SEEDS) if (!await workflows.getDefinition(tenant, seed.id, workflows.liveRef)) throw new Error('initial workflow missing');
    },
}; }
