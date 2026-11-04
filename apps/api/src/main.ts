import 'reflect-metadata';
import { branchContext } from './workspace/context.js';
import { NestFactory } from '@nestjs/core';
import { MainPublication } from './workspace/main-publication.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use((req: any, _res: any, next: () => void) => branchContext.run({ branch: typeof req.headers['x-iam-branch'] === 'string' ? req.headers['x-iam-branch'] : undefined }, next));
  await app.init();
  await app.get(MainPublication).start();
  await app.listen(Number(process.env.API_PORT ?? 3000));
}
bootstrap();
