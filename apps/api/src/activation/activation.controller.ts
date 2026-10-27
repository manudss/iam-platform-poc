import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { ActivationService } from './activation.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant/activations')
export class ActivationController {
  constructor(private readonly svc: ActivationService) {}

  @Post()
  activate(@Param('tenant') tenant: string, @Body() body: { commit: string }) {
    try {
      return this.svc.activate(tenant, body?.commit);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Get()
  list(@Param('tenant') tenant: string) {
    return this.svc.list(tenant);
  }
}
