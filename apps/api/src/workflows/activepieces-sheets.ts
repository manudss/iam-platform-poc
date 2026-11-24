import {Injectable,Logger,OnModuleInit,OnModuleDestroy} from '@nestjs/common';
import{NotFoundException}from'@nestjs/common';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {loadPluginModule} from '../plugins/v1/loader.js';
import {WorkflowStore,DefinitionRow} from './store.js';
import {WorkflowConnections} from './connections.js';
import {WorkflowsService} from './workflows.service.js';
import {PluginRegistry} from '../plugins/v1/registry.js';
import {BranchRegistries} from '../plugins/v1/branch-registries.js';
import {branchContext,workspaceMode} from '../workspace/context.js';
import {dataReady} from '../migrations/readiness.js';
const piece=()=>loadPluginModule('workflow-connectors','google-sheets-full.mjs') as any;
interface State {fingerprint:string;key:string;config:Record<string,unknown>;token:string;lastRenew:number;status:'enabling'|'active'|'review'|'disabling';reviewReason?:string;}
/** Persist native trigger cursors, pending delivery and subscription intent before effects.
 * Crashed/uncertain subscriptions stop for review, never blindly register a second channel. */
@Injectable()
export class ActivepiecesSheetsService implements OnModuleInit,OnModuleDestroy {
 private nextFilePrune=0;private timer?:NodeJS.Timeout;private busy=new Set<string>();private log=new Logger('activepieces-sheets');
 constructor(private store:WorkflowStore,private connections:WorkflowConnections,private wf:WorkflowsService,private reg:PluginRegistry,private branches:BranchRegistries){}
 onModuleInit(){this.timer=setInterval(()=>void this.tick().catch(()=>this.log.warn('Native trigger scheduler unavailable')),60_000);this.timer.unref();}
 onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
 private scope(id:string){return 'trigger:'+id;}
 private kv(tenant:string,id:string){const scope=this.scope(id);return {get:(k:string)=>this.store.pieceGet(tenant,scope,k),put:(k:string,v:unknown)=>this.store.piecePut(tenant,scope,k,v),delete:(k:string)=>this.store.pieceDelete(tenant,scope,k)};}
 private nativeStore(tenant:string,id:string){const kv=this.kv(tenant,id);const check=(k:string)=>{if(k.startsWith('lyam:'))throw Error('Reserved host state key');};return{get:(k:string)=>{check(k);return kv.get(k);},put:(k:string,v:unknown)=>{check(k);return kv.put(k,v);},delete:(k:string)=>{check(k);return kv.delete(k);}};}
 private async enabled(tenant:string){const r=workspaceMode()?await this.branches.get(this.store.liveRef):this.reg;return r.isActive(tenant,'workflow-connectors')&&r.isActive(tenant,'workflows-iga');}
 private key(d:DefinitionRow){return Object.keys(piece().GOOGLE_SHEETS_EVENTS).includes(d.trigger?.event??'')?piece().GOOGLE_SHEETS_EVENTS[d.trigger!.event!].activepiecesTrigger:null;}
 private async context(d:DefinitionRow,state:State){
  const result=await this.connections.resolve(d.tenant,this.store.liveRef,String(state.config.connectionId),'google-sheets');
  if(result.settings.googleScope!=='account')throw Error('Native catalogue requires explicitly account-scoped Google connection');
  const base=process.env.IAM_ACTIVEPIECES_API_BASE_URL??process.env.IAM_PUBLIC_BASE_URL??process.env.PUBLIC_BASE_URL??'';
  const webhook=piece().SHEETS_TRIGGERS[state.key].type==='WEBHOOK';
  if(webhook&&(!base.startsWith('https://')||new URL(base).username||new URL(base).password||new URL(base).search||new URL(base).hash))throw Error('Configure an HTTPS public base URL for Google webhook delivery');
  return {settings:result.settings,config:state.config,runtime:{store:this.nativeStore(d.tenant,d.id)},webhookUrl:base.replace(/\/$/,'')+'/tenants/'+encodeURIComponent(d.tenant)+'/activepieces-sheets/'+encodeURIComponent(d.id)+'/'+state.token};
 }
 private async invoke(d:DefinitionRow,state:State,stage:string,payload?:unknown){return piece().runSheetsTrigger(state.key,stage,{...await this.context(d,state),payload});}
 private async drain(d:DefinitionRow){
  const kv=this.kv(d.tenant,d.id),pending=await kv.get('lyam:pending') as any[]??[];
  for(const item of pending){
   const payload:Record<string,string>={data:JSON.stringify(item.data)};
   if(payload.data.length>1_000_000)throw Error('Native event exceeds 1MB storage limit');
   if(item.data&&typeof item.data==='object')for(const[k,v]of Object.entries(item.data))if(/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)&&v!==undefined&&v!==null&&typeof v!=='object')payload[k.toLowerCase()]=String(v).slice(0,500);
   await this.wf.start(d.tenant,d.id,'activepieces-sheets',{branch:this.store.liveRef,payload,eventId:item.id});
   await kv.put('lyam:pending',pending.slice(pending.indexOf(item)+1));
  }
 }
 private async collect(d:DefinitionRow,state:State,payload?:unknown){
  await this.recoverEnvelope(d);await this.drain(d);
  const kv=this.kv(d.tenant,d.id);const before=await kv.get('lyam:batch') as number??0;
  // Store updates are staged until events and native cursors are durably recorded together in one envelope.
  const staged:Record<string,unknown>={},deleted=new Set<string>();const ctx=await this.context(d,state),native=ctx.runtime.store;
  const runtime={store:{get:async(k:string)=>{if(k.startsWith('lyam:'))throw Error('Reserved host state key');return deleted.has(k)?null:k in staged?staged[k]:native.get(k);},put:async(k:string,v:unknown)=>{if(k.startsWith('lyam:'))throw Error('Reserved host state key');deleted.delete(k);staged[k]=v;},delete:async(k:string)=>{if(k.startsWith('lyam:'))throw Error('Reserved host state key');delete staged[k];deleted.add(k);}}};
  const events=await piece().runSheetsTrigger(state.key,'run',{...ctx,runtime,payload});
  if(!Array.isArray(events))throw Error('Invalid native trigger result');
  if(events.some((e:unknown)=>JSON.stringify(e).length>1_000_000))throw Error('Native event exceeds 1MB storage limit');
  const batch=before+1,pending=events.map((data:unknown,i:number)=>({id:createHash('sha256').update(JSON.stringify([d.tenant,d.id,state.fingerprint,batch,i,data])).digest('hex').slice(0,32),data}));
  await kv.put('lyam:batch-envelope',{batch,staged,deleted:[...deleted],pending});
  await this.recoverEnvelope(d);await this.drain(d);
 }
 private async drainInbox(d:DefinitionRow,state:State){
  const items=await this.store.pieceInbox(d.tenant,this.scope(d.id));if(!items.length)return;
  const current=items.filter(item=>(item.value as any).fingerprint===state.fingerprint);
  if(current.length)try{await this.collect(d,state,{headers:(current[current.length-1].value as any).headers,body:{}});}catch{await this.kv(d.tenant,d.id).put('lyam:delivery-status',{status:'review',reason:'Native trigger collection failed; notification retained'});throw Error('Native trigger collection requires review');}
  for(const item of items)await this.store.pieceDeleteExact(d.tenant,this.scope(d.id),item.key,item.value);
  await this.kv(d.tenant,d.id).delete('lyam:delivery-status');
 }
 private async recoverEnvelope(d:DefinitionRow){const kv=this.kv(d.tenant,d.id),e=await kv.get('lyam:batch-envelope') as any;if(!e)return;for(const[k,v]of Object.entries(e.staged))await kv.put(k,v);for(const k of e.deleted??[])await kv.delete(k);await kv.put('lyam:batch',e.batch);await kv.put('lyam:pending',e.pending);await kv.delete('lyam:batch-envelope');}
 private async locked<T>(tenant:string,id:string,fn:()=>Promise<T>){const k=tenant+':'+id;if(this.busy.has(k))throw Error('Native trigger is busy');this.busy.add(k);const owner=randomUUID();let claimed=false;try{claimed=await this.store.pieceClaim(tenant,this.scope(id),owner);if(!claimed)throw Error('Native trigger is busy or requires crash reconciliation');return await fn();}finally{if(claimed)await this.store.pieceRelease(tenant,this.scope(id),owner);this.busy.delete(k);}}
 async tick(){if(!dataReady())return;await branchContext.run({branch:this.store.liveRef},async()=>{
  if(Date.now()>=this.nextFilePrune){await this.store.prunePieceFiles();this.nextFilePrune=Date.now()+3600_000;}
  const defs=await this.store.listAllDefinitions(this.store.liveRef);
  for(const orphan of await this.store.pieceSubscriptions()){
    const id=orphan.scope.replace(/^trigger:/,'');
    if(defs.some(d=>d.tenant===orphan.tenant&&d.id===id&&this.key(d)))continue;
    const state=orphan.state as State;if(state.status!=='active')continue;
    const d={tenant:orphan.tenant,id} as DefinitionRow;
    try{await this.locked(d.tenant,id,async()=>{const kv=this.kv(d.tenant,id);await kv.put('lyam:subscription',{...state,status:'review',reviewReason:'Native trigger retired or changed; preserve subscription and durable state for operator reconciliation'});});}catch{this.log.warn('Deleted native trigger subscription requires review');}
  }
  for(const d of defs){if(!this.key(d))continue;try{await this.locked(d.tenant,d.id,async()=>{
   const kv=this.kv(d.tenant,d.id),prior=await kv.get('lyam:subscription') as State|null;
   const key=this.key(d),config=d.trigger!.config??{},fingerprint=createHash('sha256').update(JSON.stringify(['google-sheets',key,config])).digest('hex');
   const active=d.active!==false&&await this.enabled(d.tenant);
   if(prior&&prior.fingerprint!==fingerprint){
    // Native cursors and pending envelopes share this definition's durable scope.
    // Reusing it for a changed provider/config would reinterpret old events and
    // cursors. Preserve everything, including the former subscription, for review.
    if(prior.status==='active')await kv.put('lyam:subscription',{...prior,status:'review',reviewReason:'Trigger configuration changed; preserve prior subscription, cursors and pending events for operator reconciliation'});
    return;
   }
   if(prior&&!active){
    if(prior.status!=='active')return;
    await kv.put('lyam:subscription',{...prior,status:'disabling'});await this.invoke(d,prior,'onDisable');await kv.put('lyam:subscription',{...prior,status:'review',reviewReason:'Native trigger retired or changed; preserve subscription and durable state for operator reconciliation'});return;
   }
   if(!active)return;
   let state=prior;
   if(!state&&await this.store.pieceHasTriggerState(d.tenant,this.scope(d.id))){await kv.put('lyam:subscription',{key,config,fingerprint,token:'',lastRenew:0,status:'review',reviewReason:'Native trigger retired or changed; preserve subscription and durable state for operator reconciliation'});return;}
   if(!state){state={key,config,fingerprint,token:randomBytes(24).toString('hex'),lastRenew:Date.now(),status:'enabling'};await kv.put('lyam:subscription',state);try{await this.invoke(d,state,'onEnable');state.status='active';await kv.put('lyam:subscription',state);}catch{await kv.put('lyam:subscription',{...state,status:'review'});throw Error('Subscription setup requires review');}}
   if(state.status!=='active')return;
   await this.recoverEnvelope(d);await this.drain(d);
   const native=piece().SHEETS_TRIGGERS[key];
   if(native.type==='POLLING')await this.collect(d,state);
   else {await this.drainInbox(d,state);}
   if(native.type!=='POLLING'&&Date.now()-state.lastRenew>12*3600_000){await kv.put('lyam:subscription',{...state,status:'enabling'});await this.invoke(d,state,'onRenew');await kv.put('lyam:subscription',{...state,lastRenew:Date.now()});}
  });}catch{this.log.warn('Native Google Sheets trigger check failed; inspect connection/subscription state');}}
 });}
 async webhook(tenant:string,id:string,token:string,headers:Record<string,string>,_body:unknown){return branchContext.run({branch:this.store.liveRef},async()=>{
  const d=await this.store.getDefinition(tenant,id,this.store.liveRef);if(!d||d.active===false||!this.key(d)||!await this.enabled(tenant))throw new NotFoundException('Unknown notification subscription');
  const state=await this.kv(tenant,id).get('lyam:subscription') as State|null;
  const a=Buffer.from(state?.token??''),b=Buffer.from(token);if(!state||state.status!=='active'||a.length!==b.length||!timingSafeEqual(a,b))throw new NotFoundException('Unknown notification subscription');
  const fingerprint=createHash('sha256').update(JSON.stringify(['google-sheets',this.key(d),d.trigger?.config??{}])).digest('hex');if(fingerprint!==state.fingerprint)throw new NotFoundException('Unknown notification subscription');
  const watch=await this.kv(tenant,id).get(state.key) as any;
  if(!watch||watch.id!==headers['x-goog-channel-id']||watch.resourceId!==headers['x-goog-resource-id'])throw new NotFoundException('Unknown notification subscription');
  const safeHeaders=Object.fromEntries(['x-goog-channel-id','x-goog-resource-id','x-goog-resource-state','x-goog-changed','x-goog-message-number'].map(k=>[k,String(headers[k]??'').slice(0,500)]));
  // Durable coalesced inbox slot before ACK. A busy worker never drops a valid
  // notification. The scheduler refetches provider state under the same mutex.
  const message=String(headers['x-goog-message-number']??'');if(!/^[0-9]{1,30}$/.test(message))throw new NotFoundException('Unknown notification subscription');
  // One deterministic coalescing slot per reviewed subscription/channel. Each
  // notification triggers a full provider refetch, so no assumed message order.
  try{await this.store.pieceEnqueue(tenant,this.scope(id),{fingerprint,headers:safeHeaders});}catch(e){await this.kv(tenant,id).put('lyam:delivery-status',{status:'review',reason:'Inbox storage failed; notification not accepted'}).catch(()=>this.log.warn('Notification storage and review status unavailable'));throw e;}
  return {received:true,queued:true};
 });}
}
