import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { WorkflowsEnabledGuard } from './workflows-enabled.guard.js';
import { WorkflowTasksService } from './tasks.js';

interface Req_ { user?: { sub?: string } }

/**
 * The durable-task inbox. Any authenticated user sees and decides THEIR OWN tasks (assignee or delegate);
 * the admin subjects can see and decide everything. Deciding resumes the waiting workflow run.
 */
@UseGuards(AuthGuard, WorkflowsEnabledGuard)
@Controller('tenants/:tenant')
export class WorkflowTasksController {
  constructor(private readonly tasks: WorkflowTasksService) {}

  @Get('workflow-tasks') inbox(@Param('tenant') t: string, @Req() r: Req_, @Query('scope') scope?: string, @Query('status') status?: string) { return this.tasks.inbox(t, String(r.user?.sub ?? ''), scope, status); }
  @Post('workflow-tasks/:id/decision') decide(@Param('tenant') t: string, @Param('id') id: string, @Body() b: Record<string, unknown>, @Req() r: Req_) { return this.tasks.decide(t, id, String(r.user?.sub ?? ''), b?.decision, b?.justification); }
  @Post('workflow-tasks/:id/delegate') delegate(@Param('tenant') t: string, @Param('id') id: string, @Body() b: Record<string, unknown>, @Req() r: Req_) { return this.tasks.delegate(t, id, String(r.user?.sub ?? ''), b?.to); }
}
