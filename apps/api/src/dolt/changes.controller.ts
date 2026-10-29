import { Headers, ForbiddenException, Optional } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { Injectable, ExecutionContext } from '@nestjs/common';
@Injectable() class WorkspaceImportGuard extends AdminGuard {override canActivate(c:ExecutionContext){return workspaceMode()?super.canActivate(c):true;}}
import { SOD_SQL } from './dolt.service.js';
import { BadRequestException } from '@nestjs/common';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { scimToRows } from '../connectors/scim.connector.js';
import { csvToRows } from '../connectors/csv.connector.js';
import { DoltService } from './dolt.service.js';

@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ChangesController {
  constructor(private readonly dolt: DoltService, @Optional() private readonly v: VersioningService) {}

  @Get('assignments') assignments() { return workspaceMode() ? this.v.tableRows(currentBranch(),'assignments').then(x=>x.rows) : this.dolt.assignments(); }

  @Post('changes') simulate(@Body() b: { identity: string; role: string }) { if(workspaceMode())throw new ForbiddenException('Use workspace assignment staging');return this.dolt.simulate(b?.identity, b?.role); }

  /** CSV connector: import identities + assignments onto a new branch, with SoD simulation. */
  /** SCIM-like connector (subset, see scim.connector.ts): same branch + SoD simulation flow as CSV. */
  @UseGuards(WorkspaceImportGuard)
  @Post('connectors/scim') async scim(@Body() b: unknown) { const {rows,skipped}=scimToRows(b);return {...(workspaceMode()?await this.stageImport(rows):await this.dolt.importRows(rows)),skipped}; }
  @UseGuards(WorkspaceImportGuard)
  @Post('connectors/csv') csv(@Body() b: { csv: string }) {const rows=csvToRows(b?.csv);return workspaceMode()?this.stageImport(rows):this.dolt.importRows(rows);}

  private async stageImport(rows:ReturnType<typeof csvToRows>){
    const branch=currentBranch(true);if(!rows.length||rows.length>500)throw new BadRequestException('1 to 500 rows expected');
    return this.v.writeOn(branch,async c=>{
      const [rr]=await c.query('select id from roles');const roles=new Set((rr as {id:string}[]).map(x=>x.id));if(rows.some(x=>!roles.has(x.role)))throw new BadRequestException('unknown role in import');
      for(const r of rows){await c.query('insert into identities (id,display_name,manager_id,department) values (?,?,?,?) on duplicate key update display_name=values(display_name),manager_id=values(manager_id),department=values(department)',[r.identity,r.displayName,r.manager,r.department]);await c.query('insert ignore into assignments values (?,?)',[r.identity,r.role]);}
      const [dirty]=await c.query('select * from dolt_status');if((dirty as any[]).length){await c.query("call dolt_add('identities','assignments')");await c.query("call dolt_commit('-m',?)",[`connector import: ${rows.length} rows`]);}
      const [violations]=await c.query(SOD_SQL);return {branch,rows:rows.length,violations,staged:true,mergeable:!(violations as any[]).length};
    });
  }

  @Post('changes/:branch/merge') merge(@Param('branch') branch: string) { if(workspaceMode())throw new ForbiddenException('Use global Apply');return this.dolt.merge(branch); }
}
