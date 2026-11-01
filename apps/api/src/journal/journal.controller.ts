import { BadRequestException, Controller, ForbiddenException, Get, Optional, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { journalStore } from './journal.js';

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const KINDS = ['plugin-hook', 'app-event'];
function iso(v: string | undefined, name: string) {
  if (v === undefined || v === '') return undefined;
  if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw new BadRequestException(`${name} must be an ISO date`);
  return new Date(v).toISOString();
}

/**
 * Hooks journal API: READ ONLY. There is no route that emits, replays or answers anything; every route is a GET.
 * Needs a sign-in and the admin capability, and answers 403 while the `hooks-journal` plugin is not enabled for the tenant.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/journal')
export class JournalController {
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}
  private async enabled(tenant: string) {
    const r = workspaceMode() && this.branches ? await this.branches.get(currentBranch()) : this.reg;
    if (!r.isActive(tenant, 'hooks-journal')) throw new ForbiddenException('the hooks journal plugin is not enabled');
  }
  @Get('entries') async entries(@Param('tenant') t: string, @Query('from') from?: string, @Query('to') to?: string, @Query('kind') kind?: string, @Query('name') name?: string, @Query('outcome') outcome?: string, @Query('limit') limit?: string) {
    await this.enabled(t);
    if (kind && !KINDS.includes(kind)) throw new BadRequestException('unknown kind');
    const n = limit === undefined ? undefined : Number(limit);
    if (n !== undefined && !Number.isInteger(n)) throw new BadRequestException('limit must be an integer');
    return { tenant: t, recordingSince: journalStore.recordingSince(t) ?? null, note: 'Read-only. Nothing before recordingSince exists in this journal.', ...journalStore.query({ tenant: t, from: iso(from, 'from'), to: iso(to, 'to'), kind, name, outcome, limit: n }) };
  }
  @Get('summary') async summary(@Param('tenant') t: string, @Query('from') from?: string, @Query('to') to?: string) {
    await this.enabled(t);
    return journalStore.summary({ tenant: t, from: iso(from, 'from'), to: iso(to, 'to') });
  }
}
