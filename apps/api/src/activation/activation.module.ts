import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { Module } from '@nestjs/common';
import { ActivationController } from './activation.controller.js';
import { DoltModule } from '../dolt/dolt.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { EffectsService } from '../effects/effects.service.js';
import { ActivationReadService } from './activation-read.service.js';
import { ActivationService } from './activation.service.js';

@Module({ imports: [DoltModule, IntegrationsModule, PluginsV1Module], controllers: [ActivationController], providers: [ActivationReadService, ActivationService, EffectsService], exports: [ActivationService] })
export class ActivationModule {}
