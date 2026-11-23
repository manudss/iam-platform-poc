import { Controller, Get, Req, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { filterPeople } from '../access/scope.js';
import { UsersService } from '../users/users.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { Block } from './blocks.js';

/** Read-only directory summary. Reasons, setters and references remain behind account-blocks permission. */
export function directoryAccountStatus(live: { login_enabled: boolean; hasCredential: boolean } | undefined, blocks: Block[]) {
  return {
    published: !!live,
    loginEnabled: live?.login_enabled ?? false,
    hasCredential: live?.hasCredential ?? false,
    // Keep expiry metadata so a list left open cannot keep showing an expired lock as active.
    blocks: blocks.map(({ kind, until, hold }) => ({ kind, ...(until === undefined ? {} : { until }), ...(hold ? { hold: true } : {}) })),
  };
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant')
export class DirectoryAccountStatusController {
  constructor(private readonly users: UsersService, private readonly authn: AuthnService) {}
  protected scope = filterPeople;
  @Get('directory-account-status') async list(@Param('tenant') tenant: string, @Req() req: { user: { sub: string } }) {
    const visible = await this.scope(tenant, req.user.sub, 'user:read', await this.users.list(), u => String(u.id));
    const live = new Map((await this.users.list('main')).map(u => [u.id, u]));
    const accounts: Record<string, ReturnType<typeof directoryAccountStatus>> = Object.create(null);
    for (const u of visible) accounts[u.id] = directoryAccountStatus(live.get(u.id), await this.authn.blocks.list(tenant, u.id));
    return { asOf: Date.now(), accounts };
  }
}
