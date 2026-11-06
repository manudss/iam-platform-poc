import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { DEFAULT_SESSION, SESSION_LIMITS } from './session-config.js';

/**
 * Session length settings of one tenant (docs/session.md). Reads need a sign-in. Writes need the admin capability and, in workspace mode, a
 * working branch: they never change live sign-in until Apply. A change applies to the NEXT sign-in; issued tokens keep their length.
 */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/session')
export class SessionAdminController {
  constructor(private readonly authn: AuthnService) {}

  @Get() async get(@Param('tenant') t: string) {
    return { tenant: t, working: await this.authn.workingSession(t), live: await this.authn.liveSession(t), defaults: DEFAULT_SESSION, limits: SESSION_LIMITS };
  }
  @UseGuards(AdminGuard) @Put() async put(@Param('tenant') t: string, @Body() b: { config?: unknown }) {
    return { saved: true, config: await this.authn.saveSession(t, b?.config) };
  }
}
