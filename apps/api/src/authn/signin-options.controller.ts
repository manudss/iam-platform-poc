import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Optional, Param, Query } from '@nestjs/common';
import { AuthnService } from './flow.service.js';
import { BranchTestService } from '../workspace/branch-test.js';
import { branchName } from '../versioning/guards.js';

/**
 * PUBLIC (no sign-in, nothing to sign in with yet): which sign-in chains the live configuration offers.
 * Only names, declared levels and step names: no user, enrollment, secret or draft (working-branch) data.
 * A data branch can be tested (docs/branch-test.md) only with the short-lived ticket the console issued to an
 * administrator for exactly that branch: knowing a branch name never reveals its configuration here.
 */
@Controller('tenants/:tenant/signin')
export class SigninOptionsController {
  constructor(private readonly authn: AuthnService, @Optional() private readonly branchTest?: BranchTestService) {}
  @Get('options') async options(@Param('tenant') t: string, @Query('branch') branch?: string, @Query('ticket') ticket?: string) {
    if (!/^[a-z0-9-]{1,32}$/.test(t)) throw new BadRequestException('invalid tenant');
    if (typeof branch === 'string' && branch) {
      branchName(branch);
      if (branch === 'main') throw new BadRequestException('main is the live sign-in already: nothing to test');
      if (!this.branchTest?.check(ticket, branch)) throw new ForbiddenException('a branch test needs the ticket of a test link from the branch bar');
      try { return await this.authn.options(t, branch); } catch { throw new NotFoundException('unknown data branch'); }
    }
    return this.authn.options(t);
  }
}