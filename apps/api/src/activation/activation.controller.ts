import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
      return await this.svc.activate(tenant, body?.commit ?? (await this.dolt.head()));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get()
  async list(@Param('tenant') tenant: string) {
    return this.svc.list(tenant);
  }
}
