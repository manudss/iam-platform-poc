import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ActivationModule } from './activation/activation.module.js';
import { AccessController } from './access/access.controller.js';
import { PluginsModule } from './plugins/plugins.module.js';

@Module({ imports: [ActivationModule, PluginsModule], controllers: [HealthController, AccessController] })
export class AppModule {}
