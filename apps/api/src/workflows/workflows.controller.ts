import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { WorkflowsService } from './workflows.service.js';

interface Req_ { user?: { sub?: string } }

/**
 * Workflow definitions and runs. Same capability level as the users administration (AuthGuard + AdminGuard):
 * starting a run CAN write real data (on its own Dolt branch only), so it is an admin action.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant')
export class WorkflowsController {
  constructor(private readonly wf: WorkflowsService) {}

  @Get('workflows') list(@Param('tenant') t: string) { return this.wf.list(t); }
  @Post('workflows') create(@Param('tenant') t: string, @Body() b: Record<string, unknown>, @Req() r: Req_) { return this.wf.save(t, undefined, b ?? {}, r.user?.sub, true); }
  @Get('workflows/:id') get(@Param('tenant') t: string, @Param('id') id: string) { return this.wf.get(t, id); }
  @Put('workflows/:id') update(@Param('tenant') t: string, @Param('id') id: string, @Body() b: Record<string, unknown>, @Req() r: Req_) { return this.wf.save(t, id, b ?? {}, r.user?.sub, false); }
  @Delete('workflows/:id') remove(@Param('tenant') t: string, @Param('id') id: string) { return this.wf.remove(t, id); }
  @Post('workflows/:id/runs') start(@Param('tenant') t: string, @Param('id') id: string, @Req() r: Req_) { return this.wf.start(t, id, r.user?.sub); }

  @Get('workflow-runs') runs(@Param('tenant') t: string, @Query('definition') definition?: string) { return this.wf.listRuns(t, definition); }
  @Get('workflow-runs/:runId') run(@Param('tenant') t: string, @Param('runId') runId: string) { return this.wf.runView(t, runId); }
  @Post('workflow-runs/:runId/retry') retry(@Param('tenant') t: string, @Param('runId') runId: string) { return this.wf.retry(t, runId); }
  @Post('workflow-runs/:runId/cancel') cancel(@Param('tenant') t: string, @Param('runId') runId: string) { return this.wf.cancel(t, runId); }
  @Post('workflow-runs/:runId/review') review(@Param('tenant') t: string, @Param('runId') runId: string, @Req() r: Req_) { return this.wf.review(t, runId, r.user?.sub); }
}
