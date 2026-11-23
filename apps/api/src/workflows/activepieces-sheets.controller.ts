import {Body,Controller,Param,Post,Req,UseGuards,NotFoundException} from '@nestjs/common';
import {AuthGuard} from '../auth/auth.guard.js';
import {AdminGuard} from '../auth/admin.guard.js';
import {WorkflowsEnabledGuard} from './workflows-enabled.guard.js';
import {ActivepiecesSheetsService} from './activepieces-sheets.js';
import {WorkflowConnections} from './connections.js';
import {currentBranch} from '../workspace/context.js';
import {WorkflowStore} from './store.js';
import {loadPluginModule} from '../plugins/v1/loader.js';
@Controller('tenants/:tenant')
export class ActivepiecesSheetsController{
 constructor(private service:ActivepiecesSheetsService,private connections:WorkflowConnections,private store:WorkflowStore){}
 @Post('activepieces-sheets/:definition/:token')
 async hook(@Param('tenant')t:string,@Param('definition')d:string,@Param('token')token:string,@Req()req:any,@Body()body:unknown){try{return await this.service.webhook(t,d,token,req.headers,body);}catch{throw new NotFoundException('Unknown notification subscription');}}
 @UseGuards(AuthGuard,AdminGuard,WorkflowsEnabledGuard)
 @Post('activepieces-sheets-properties')
 async properties(@Param('tenant')t:string,@Body()body:any){
  const resolved=await this.connections.resolve(t,currentBranch(),String(body.connectionId),'google-sheets');
  if(resolved.settings.googleScope!=='account')throw new NotFoundException('An account-scoped connection is required');
  const p=loadPluginModule('workflow-connectors','google-sheets-full.mjs') as any;
  return {property:await p.resolveSheetProperty(String(body.action),String(body.property),{settings:resolved.settings,config:body.config??{}})};
 }
}
