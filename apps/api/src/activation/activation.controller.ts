import { workspaceMode } from '../workspace/context.js';
import { ForbiddenException } from '@nestjs/common';
import { BadGatewayException, BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { ActivationService } from './activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant/activations')
export class ActivationController {
  constructor(private readonly svc: ActivationService, private readonly dolt: DoltService) {}

  @UseGuards(AdminGuard)
  @Post()
  async activate(@Param('tenant') tenant: string, @Body() body: { commit?: string; requestId?: string }) {
    if(workspaceMode())throw new ForbiddenException('Apply working data first. Policy publication is separate and disabled in this sandbox workspace.');
    try {
      // No commit given: activate the current Dolt main head.
      const r = await this.svc.activate(tenant, body?.commit ?? (await this.dolt.head()), body?.requestId);
      if (r.state === 'failed') throw new BadGatewayException(r);
      return r;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      throw new BadRequestException((e as Error).message);
    }
  }

  @UseGuards(AdminGuard)
  @Post('reconcile')
  async reconcile(@Param('tenant') tenant: string) {
    if(workspaceMode())throw new ForbiddenException('Policy publication is disabled in workspace mode');
    return this.svc.reconcile(tenant);
  }

  @Get()
  async list(@Param('tenant') tenant: string) {
    return this.svc.list(tenant);
  }
}
