import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { csvToRows } from '../connectors/csv.connector.js';
import { DoltService } from './dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ChangesController {
  constructor(private readonly dolt: DoltService) {}

  @Get('assignments') assignments() { return this.dolt.assignments(); }

  @Post('changes') simulate(@Body() b: { identity: string; role: string }) { return this.dolt.simulate(b?.identity, b?.role); }

  /** CSV connector: import identities + assignments onto a new branch, with SoD simulation. */
  @Post('connectors/csv') csv(@Body() b: { csv: string }) { return this.dolt.importRows(csvToRows(b?.csv)); }

  @Post('changes/:branch/merge') merge(@Param('branch') branch: string) { return this.dolt.merge(branch); }
}
