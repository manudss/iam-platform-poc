import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { authorOf } from './guards.js';
import { PullRequestService } from './pull-requests.service.js';
import { EditOp, VersioningService } from './versioning.service.js';

type Req_ = { user?: { sub?: string } };
const flag = (v: unknown) => v === true || v === 'true' || v === '1';

/**
 * Database explorer API (Dolt: branches, history, diffs, data, SQL console, pull requests).
 *
 * EVERY route needs a valid sign-in for the tenant AND the admin capability (controller-level guards, so a route added later cannot
 * forget them; a test walks the route table to prove it). Reads are admin-only too: the explorer shows raw tables and the Dolt
 * database is not split per tenant, so this is an operator tool, not a tenant feature.
 */
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/versioning')
export class VersioningController {
  constructor(private readonly v: VersioningService, private readonly prs: PullRequestService) {}

  // branches and tags
  @Get('branches') branches() { return this.v.branches(); }
  @Post('branches') createBranch(@Body() b: { name?: string; from?: string }) { return this.v.createBranch(b?.name as string, b?.from ?? this.v.defaultBranch); }
  @Delete('branches/:name') deleteBranch(@Param('name') n: string) { return this.v.deleteBranch(n, (x) => this.prs.hasOpen(x)); }
  @Post('branches/:name/restore') restore(@Param('name') n: string, @Body() b: { commit?: string; confirm?: boolean }) { return this.v.resetBranch(n, b?.commit as string, b?.confirm === true); }
  @Get('tags') tags() { return this.v.tags(); }
  @Post('tags') createTag(@Body() b: { name?: string; commit?: string; message?: string }, @Req() r: Req_) { return this.v.createTag(b?.name as string, b?.commit as string, b?.message, authorOf(r.user?.sub)); }
  @Delete('tags/:name') deleteTag(@Param('name') n: string) { return this.v.deleteTag(n); }

  // history and diff
  @Get('log') log(@Query('ref') ref = this.v.defaultBranch, @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.v.log(ref, Number(limit ?? 50), Number(offset ?? 0)); }
  @Get('commits/:hash') commit(@Param('hash') h: string) { return this.v.commit(h); }
  @Post('commits/:hash/revert') revert(@Param('hash') h: string, @Body() b: { onto?: string; newBranch?: string; base?: string; message?: string }, @Req() r: Req_) { return this.v.revert(h, { onto: b?.onto, newBranch: b?.newBranch, base: b?.base }, b?.message, r.user?.sub); }
  @Get('diff') diff(@Query('from') from: string, @Query('to') to: string, @Query('three') three?: string) {
    if (!from || !to) throw new BadRequestException('from and to required');
    return this.v.diffSummary(from, to, flag(three));
  }
  @Get('diff/:table') diffTable(@Param('table') t: string, @Query('from') from: string, @Query('to') to: string, @Query('three') three?: string, @Query('limit') limit?: string) {
    if (!from || !to) throw new BadRequestException('from and to required');
    return this.v.diffTable(from, to, t, flag(three), Number(limit ?? 100));
  }

  // data
  @Get('tables') tables(@Query('ref') ref = this.v.defaultBranch) { return this.v.tables(ref); }
  @Get('tables/:table') rows(@Param('table') t: string, @Query('ref') ref = this.v.defaultBranch, @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.v.tableRows(ref, t, Number(limit ?? 50), Number(offset ?? 0)); }
  @Post('tables/:table/edit') edit(@Param('table') t: string, @Body() b: { branch?: string; ops?: EditOp[]; message?: string }, @Req() r: Req_) { return this.v.editRows(b?.branch as string, t, b?.ops as EditOp[], b?.message, r.user?.sub); }

  // SQL console
  @Post('sql') sql(@Body() b: { ref?: string; sql?: string; mode?: string; message?: string; dryRun?: boolean; confirmDestructive?: boolean }, @Req() r: Req_) {
    if (b?.mode === 'write') return this.v.sqlWrite(b.ref as string, b.sql as string, { message: b.message, dryRun: b.dryRun === true, confirmDestructive: b.confirmDestructive === true }, r.user?.sub);
    return this.v.sqlRead(b?.ref ?? this.v.defaultBranch, b?.sql as string);
  }

  // pull requests
  @Get('pulls') pulls(@Param('tenant') t: string, @Query('status') s?: string) { return this.prs.list(t, s); }
  @Post('pulls') openPull(@Param('tenant') t: string, @Body() b: { title?: string; body?: string; source?: string; target?: string }, @Req() r: Req_) { return this.prs.create(t, b ?? {}, r.user?.sub); }
  @Get('pulls/:id') pull(@Param('tenant') t: string, @Param('id', ParseIntPipe) id: number, @Req() r: Req_) { return this.prs.get(t, id, r.user?.sub); }
  @Post('pulls/:id/comments') comment(@Param('tenant') t: string, @Param('id', ParseIntPipe) id: number, @Body() b: { body?: string; kind?: string }, @Req() r: Req_) { return this.prs.comment(t, id, b ?? {}, r.user?.sub); }
  @Post('pulls/:id/close') close(@Param('tenant') t: string, @Param('id', ParseIntPipe) id: number) { return this.prs.close(t, id); }
  @Post('pulls/:id/merge') merge(@Param('tenant') t: string, @Param('id', ParseIntPipe) id: number, @Req() r: Req_) { return this.prs.merge(t, id, r.user?.sub); }
}
