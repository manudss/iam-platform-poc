import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { AuthnService } from './flow.service.js';

/**
 * PUBLIC (no sign-in, nothing to sign in with yet): which sign-in chains the live configuration offers.
 * Only names, declared levels and step names: no user, enrollment, secret or draft (working-branch) data.
 */
@Controller('tenants/:tenant/signin')
export class SigninOptionsController {
  constructor(private readonly authn: AuthnService) {}
  @Get('options') async options(@Param('tenant') t: string) {
    if (!/^[a-z0-9-]{1,32}$/.test(t)) throw new BadRequestException('invalid tenant');
    return this.authn.options(t);
  }
}
