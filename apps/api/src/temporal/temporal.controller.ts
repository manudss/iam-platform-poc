import { BadRequestException, Body, Controller, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DoltService } from '../dolt/dolt.service.js';
import { TemporalService } from './temporal.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant/activation-workflows')
export class TemporalController {
  constructor(private readonly t: TemporalService, private readonly dolt: DoltService) {}

  /** Same effect as POST .../activations, executed as a Temporal workflow (verify commit, then journal + event). */
  @Post()
  async run(@Param('tenant') tenant: string, @Body() body: { commit?: string; requestId?: string }) {
    if (!this.t.enabled) throw new ServiceUnavailableException('Temporal not configured (IAM_TEMPORAL_ADDR)');
    try { return await this.t.activate(tenant, body?.commit ?? (await this.dolt.head())); }
    catch (e) { throw new BadRequestException((e as Error).message.slice(0, 200)); }
  }
}
