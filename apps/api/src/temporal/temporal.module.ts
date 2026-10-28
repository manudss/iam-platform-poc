import { Module } from '@nestjs/common';
import { ActivationModule } from '../activation/activation.module.js';
import { DoltModule } from '../dolt/dolt.module.js';
import { TemporalController } from './temporal.controller.js';
import { TemporalService } from './temporal.service.js';

@Module({ imports: [ActivationModule, DoltModule], controllers: [TemporalController], providers: [TemporalService], exports: [TemporalService] })
export class TemporalModule {}
