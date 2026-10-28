import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { DoltService } from './dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ChangesController {
  constructor(private readonly dolt: DoltService) {}

  @Get('assignments') assignments() { return this.dolt.assignments(); }

  @Post('changes') simulate(@Body() b: { identity: string; role: string }) { return this.dolt.simulate(b?.identity, b?.role); }

  @Post('changes/:branch/merge') merge(@Param('branch') branch: string) { return this.dolt.merge(branch); }
}
