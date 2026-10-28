import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { scimToRows } from '../connectors/scim.connector.js';
import { csvToRows } from '../connectors/csv.connector.js';
import { DoltService } from './dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ChangesController {
  constructor(private readonly dolt: DoltService) {}

  @Get('assignments') assignments() { return this.dolt.assignments(); }

  @Post('changes') simulate(@Body() b: { identity: string; role: string }) { return this.dolt.simulate(b?.identity, b?.role); }

  /** CSV connector: import identities + assignments onto a new branch, with SoD simulation. */
  /** SCIM-like connector (subset, see scim.connector.ts): same branch + SoD simulation flow as CSV. */
  @Post('connectors/scim') async scim(@Body() b: unknown) { const { rows, skipped } = scimToRows(b); return { ...(await this.dolt.importRows(rows)), skipped }; }
  @Post('connectors/csv') csv(@Body() b: { csv: string }) { return this.dolt.importRows(csvToRows(b?.csv)); }

  @Post('changes/:branch/merge') merge(@Param('branch') branch: string) { return this.dolt.merge(branch); }
}
