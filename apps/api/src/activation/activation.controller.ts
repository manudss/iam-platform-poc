import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ActivationService } from './activation.service.js';

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
