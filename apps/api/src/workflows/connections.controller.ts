import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { WorkflowsEnabledGuard } from './workflows-enabled.guard.js';
import { WorkflowConnections } from './connections.js';
@UseGuards(AuthGuard, AdminGuard, WorkflowsEnabledGuard)
@Controller('tenants/:tenant/workflow-connections')
export class WorkflowConnectionsController {
  constructor(private readonly connections: WorkflowConnections) {}
  @Get() list(@Param('tenant') t: string) { return this.connections.list(t); }
  @Post() create(@Param('tenant') t: string, @Body() b: Record<string, unknown>) { return this.connections.save(t, undefined, b ?? {}); }
  @Put(':id') update(@Param('tenant') t: string, @Param('id') id: string, @Body() b: Record<string, unknown>) { return this.connections.save(t, id, b ?? {}); }
  @Post(':id/test') test(@Param('tenant') t: string, @Param('id') id: string) { return this.connections.test(t, id); }
  @Delete(':id') remove(@Param('tenant') t: string, @Param('id') id: string) { return this.connections.remove(t, id); }
}
