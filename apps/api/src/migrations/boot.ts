import type { INestApplication } from '@nestjs/common';
import { migrationPaths } from './cli.js';
import { migrate } from './journal.js';
import { initialMigration } from './v0001/run.js';
import { nativeConnectorStorageMigration } from './v0003/run.js';
import { accountBlocksRuleMigration } from './v0002/run.js';

/** Append new version factories here, with a matching immutable manifest entry. */
export async function runBootMigrations(app: INestApplication) {
  if (process.env.IAM_DATA_MIGRATIONS !== '1') return;
  const { journal } = migrationPaths();
  const bootId = process.env.IAM_MIGRATION_BOOT_ID;
  if (!bootId) throw new Error('migration boot context missing');
  const tenant = process.env.IAM_AUTHN_DEMO_SEED_TENANT || 'acme-demo';
  await migrate(journal, bootId, [initialMigration(app, journal, bootId, tenant), accountBlocksRuleMigration(app), nativeConnectorStorageMigration(app)]);
}
