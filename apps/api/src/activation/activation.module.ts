import { Module } from '@nestjs/common';
import { ActivationController } from './activation.controller.js';
import { ActivationService } from './activation.service.js';

@Module({ controllers: [ActivationController], providers: [ActivationService], exports: [ActivationService] })
export class ActivationModule {}
