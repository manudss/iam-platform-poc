import { Module } from '@nestjs/common';
import { ActivationController } from './activation.controller.js';
import { DoltModule } from '../dolt/dolt.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { ActivationService } from './activation.service.js';

@Module({ imports: [DoltModule, IntegrationsModule], controllers: [ActivationController], providers: [ActivationService], exports: [ActivationService] })
export class ActivationModule {}
