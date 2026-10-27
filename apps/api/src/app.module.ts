import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ActivationModule } from './activation/activation.module.js';
import { PluginsModule } from './plugins/plugins.module.js';

@Module({ imports: [ActivationModule, PluginsModule], controllers: [HealthController] })
export class AppModule {}
