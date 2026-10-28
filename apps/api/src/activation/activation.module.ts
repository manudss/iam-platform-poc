import { Module } from '@nestjs/common';
import { ActivationController } from './activation.controller.js';
import { DoltModule } from '../dolt/dolt.module.js';
import { ActivationService } from './activation.service.js';

@Module({ imports: [DoltModule], controllers: [ActivationController], providers: [ActivationService], exports: [ActivationService] })
export class ActivationModule {}
