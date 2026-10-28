import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ActivationModule } from './activation/activation.module.js';
import { AccessController } from './access/access.controller.js';
import { DoltModule } from './dolt/dolt.module.js';
import { TemporalModule } from './temporal/temporal.module.js';
import { PluginsModule } from './plugins/plugins.module.js';

@Module({ imports: [DoltModule, ActivationModule, PluginsModule, TemporalModule], controllers: [HealthController, AccessController] })
export class AppModule {}
