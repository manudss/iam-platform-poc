import { Module } from '@nestjs/common';
import { NatsService } from './nats.service.js';
import { SecretsService } from './secrets.service.js';

@Module({ providers: [NatsService, SecretsService], exports: [NatsService, SecretsService] })
export class IntegrationsModule {}
