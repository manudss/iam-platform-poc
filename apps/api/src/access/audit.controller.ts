import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuditService } from './audit.service.js';

/** Read the decision audit of ONE tenant. The guard enforces token tenant == :tenant (403 otherwise). */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get()
  async list(@Param('tenant') tenant: string, @Query('limit') limit?: string) {
    return { tenant, entries: await this.audit.list(tenant, limit ? Number(limit) : 100) };
  }
}
