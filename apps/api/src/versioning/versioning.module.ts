import { Module } from '@nestjs/common';
import { PullRequestService } from './pull-requests.service.js';
import { VersioningController } from './versioning.controller.js';
import { BranchProtectionService } from './branch-protection.service.js';
import { VersioningService } from './versioning.service.js';
import { BranchTestService } from '../workspace/branch-test.js';

@Module({ controllers: [VersioningController], providers: [VersioningService, PullRequestService, BranchProtectionService, BranchTestService], exports: [VersioningService, PullRequestService, BranchProtectionService, BranchTestService] })
export class VersioningModule {}
