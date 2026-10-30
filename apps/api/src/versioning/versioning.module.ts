import { Module } from '@nestjs/common';
import { PullRequestService } from './pull-requests.service.js';
import { VersioningController } from './versioning.controller.js';
import { VersioningService } from './versioning.service.js';

@Module({ controllers: [VersioningController], providers: [VersioningService, PullRequestService], exports: [VersioningService, PullRequestService] })
export class VersioningModule {}
