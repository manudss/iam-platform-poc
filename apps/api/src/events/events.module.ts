import { Global, Module } from '@nestjs/common';
import { ApplicationBus } from './application-bus.service.js';

@Global()
@Module({ providers: [ApplicationBus], exports: [ApplicationBus] })
export class EventsModule {}
