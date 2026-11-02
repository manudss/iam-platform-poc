import { Module } from '@nestjs/common';
import { BusObserverController } from './bus.controller.js';
@Module({ controllers: [BusObserverController] })
export class BusModule {}
