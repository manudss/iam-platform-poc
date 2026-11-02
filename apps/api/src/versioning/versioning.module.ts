import { Module } from '@nestjs/common';
import { PullRequestService } from './pull-requests.service.js';
import { VersioningController } from './versioning.controller.js';
import { VersioningService } from './versioning.service.js';
import { BranchTestService } from '../workspace/branch-test.js';

@Module({ controllers: [VersioningController], providers: [VersioningService, PullRequestService, BranchTestService], exports: [VersioningService, PullRequestService, BranchTestService] })
export class VersioningModule {}
