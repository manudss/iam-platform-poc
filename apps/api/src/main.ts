import { releaseDataReady } from './migrations/readiness.js';
import { runBootMigrations } from './migrations/boot.js';
import { migrationPaths } from './migrations/cli.js';
import 'reflect-metadata';
import { branchContext } from './workspace/context.js';
import { NestFactory } from '@nestjs/core';
import { MainPublication } from './workspace/main-publication.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  if (process.env.IAM_DATA_MIGRATIONS === '1') migrationPaths().journal.assertBoot(process.env.IAM_MIGRATION_BOOT_ID ?? '');
  const app = await NestFactory.create(AppModule);
  // Signed plugin archives upload as base64 JSON (plan step 8): 2 MB zip -> ~2.7 MB base64.
  const bodyParser = (app as unknown as { useBodyParser?: (type: string, opts: { limit: string }) => void }).useBodyParser;
  bodyParser?.call(app, 'json', { limit: '8mb' });
  app.use((req: any, _res: any, next: () => void) => branchContext.run({ branch: typeof req.headers['x-iam-branch'] === 'string' ? req.headers['x-iam-branch'] : undefined }, next));
  await app.init();
  await runBootMigrations(app);
  await app.get(MainPublication).start();
  releaseDataReady();
  await app.listen(Number(process.env.API_PORT ?? 3000));
}
bootstrap().catch(() => { console.error('[startup] startup failed; preserve migration journal and backups, no automatic seed/reset'); process.exit(1); });
