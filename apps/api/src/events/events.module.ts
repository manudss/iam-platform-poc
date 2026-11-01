import { Global, Module } from '@nestjs/common';
import { AppEvents } from './app-events.service.js';

@Global()
@Module({ providers: [AppEvents], exports: [AppEvents] })
export class EventsModule {}
