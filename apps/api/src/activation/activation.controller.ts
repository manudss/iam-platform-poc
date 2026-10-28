import { BadGatewayException, BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ActivationService } from './activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant/activations')
export class ActivationController {
  constructor(private readonly svc: ActivationService, private readonly dolt: DoltService) {}

  @Post()
  async activate(@Param('tenant') tenant: string, @Body() body: { commit?: string }) {
    try {
      // No commit given: activate the current Dolt main head.
      const r = await this.svc.activate(tenant, body?.commit ?? (await this.dolt.head()));
      if (r.state === 'failed') throw new BadGatewayException(r);
      return r;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      throw new BadRequestException((e as Error).message);
    }
  }

  @Post('reconcile')
  async reconcile(@Param('tenant') tenant: string) {
    return this.svc.reconcile(tenant);
  }

  @Get()
  async list(@Param('tenant') tenant: string) {
    return this.svc.list(tenant);
  }
}
