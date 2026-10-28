import { Module } from '@nestjs/common';
import { ChangesController } from './changes.controller.js';
import { DoltService } from './dolt.service.js';

@Module({ controllers: [ChangesController], providers: [DoltService], exports: [DoltService] })
export class DoltModule {}
