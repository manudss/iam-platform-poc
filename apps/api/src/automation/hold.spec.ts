import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('./hold.js', import.meta.url).href;
function run(code: string, value?: string, extra: Record<string, string> = {}) {
  const env = { ...process.env, ...extra }; delete env.IAM_AUTOMATION_HOLD;
  if (value !== undefined) env.IAM_AUTOMATION_HOLD = value;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 15000 });
}
for (const value of [undefined, '1', '', '0', 'false', ' ', ' 1', '1 ', 'true', 'typo']) {
  it(`startup contract ${JSON.stringify(value)}`, () => {
    const r = run(`const h = await import(${JSON.stringify(moduleUrl)}); console.log(h.automationHeld);`, value);
    if (value === undefined || value === '1') { assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), String(value === '1')); }
    else { assert.notEqual(r.status, 0); assert.match(r.stderr, /invalid configuration refuses startup/); }
  });
}
for (const value of [undefined, '1']) it(`startup capture is immutable ${value}`, () => {
  const r = run(`const h=await import(${JSON.stringify(moduleUrl)}); process.env.IAM_AUTOMATION_HOLD=${value === '1' ? "''" : "'1'"}; if(h.automationHeld!==${value === '1'}) throw Error('changed');`, value);
  assert.equal(r.status, 0, r.stderr);
});
it('held workflow entry points make no store/provider access (Map is only a retained sentinel)', () => {
  const base = new URL('../', import.meta.url).href;
  const r = run(`
    import assert from 'node:assert/strict';
    const load = p => import(${JSON.stringify(base)}+p+'.js');
    const {releaseDataReady}=await load('migrations/readiness');
    const calls=[];
    // This sentinel is not SQL persistence evidence. All store accesses must be refused before it.
    const persisted=new Map([
      ['run:queued',{id:'queued',status:'queued'}],['run:running',{id:'running',status:'running'}],
      ['run:parent',{id:'parent',status:'waiting',child:'mail-child'}],
      ['run:mail-child',{id:'mail-child',status:'queued',started_by:'workflow:parent',graph:{nodes:[{id:'mail',type:'lyam-send-mail',config:{to:'nobody@example.invalid'}}],edges:[]}}],
      ['cron-fired:t:d','old-minute'],['task:approval',{status:'open'}]
    ]);
    const before=JSON.stringify([...persisted]);
    const blocked=new Proxy({}, {get:(_,key)=> { calls.push(String(key)); throw Error('unexpected store/provider access '+String(key)); }});
    globalThis.fetch=async()=> {calls.push('fetch'); throw Error('provider called');};
    await load('plugins/v1/registry');
    const {WorkflowEngine}=await load('workflows/engine');
    const engine=new WorkflowEngine(blocked,{defaultBranch:'main'},blocked);
    const {WorkflowsService}=await load('workflows/workflows.service');
    const wf=new WorkflowsService(blocked,engine,blocked,blocked);
    const {WorkflowTasksService}=await load('workflows/tasks');
    const tasks=new WorkflowTasksService(blocked);
    const {WorkflowConnections}=await load('workflows/connections');
    const connections=new WorkflowConnections(blocked);
    const refused=async fn=>assert.rejects(fn,e=>e.getStatus?.()===503);
    for (const name of ['save','saveTemplate','removeTemplate','remove','setActive','removeRun','start','testRun','rerunFrom','duplicate','retry','cancel','review']) await refused(()=>wf[name]());
    for (const name of ['request','consume','markApplied','decide','delegate','reassignOpen','settleSystem','cancelForRun']) await refused(()=>tasks[name]());
    for (const name of ['save','remove','test','testDraft','resolve']) await refused(()=>connections[name]());
    await engine.onModuleInit(); releaseDataReady(); await engine.onModuleInit();
    await engine.scanChildWaits(); await engine.resumeWithRetry({},'unavailable');
    for(const row of persisted.values()) if(row.id) {engine.kick(row.id); await refused(()=>engine.engineFor(row));}
    await refused(()=>engine.clearStaleCancel('queued',1));
    await refused(()=>engine.runEffects().start());
    assert.equal(await tasks.scanOverdue(),0);
    for(const [file,cls] of [['cron','WorkflowCronService'],['sheet-poller','WorkflowSheetPollerService'],['jira-done-poller','WorkflowJiraDonePollerService']]) {
      const C=(await load('workflows/'+file))[cls];const x=new C(blocked,wf,blocked,blocked,blocked);
      x.onModuleInit();assert.equal(x.timer,undefined);assert.equal(x.first,undefined);await x.tick();x.onModuleDestroy();
    }
    const {WorkflowTriggersService}=await load('workflows/triggers'); const triggers=new WorkflowTriggersService(blocked,blocked,wf,blocked);
    triggers.onModuleInit();await refused(()=>triggers.dispatch({}));
    const {WorkflowHooksController}=await load('workflows/hooks.controller');await refused(()=>new WorkflowHooksController(blocked,wf,blocked).fire());
    const {WorkflowsEnabledGuard}=await load('workflows/workflows-enabled.guard');
    for(const method of ['POST','PUT','PATCH','DELETE']) await refused(()=>new WorkflowsEnabledGuard(blocked).canActivate({switchToHttp:()=>({getRequest:()=>({method})})}));
    const {EffectsService}=await load('effects/effects.service'); await new EffectsService(blocked,blocked,blocked).onModuleInit();
    const {MainPublication}=await load('workspace/main-publication'); await new MainPublication(blocked,blocked,blocked,blocked,blocked).start();
    const {ActivationService}=await load('activation/activation.service'); const activation=new ActivationService(blocked,blocked);activation.onModuleInit();assert.equal(activation.timer,undefined);assert.deepEqual(await activation.tick(),{reconciled:[]});
    await new Promise(r=>setTimeout(r,30));engine.onModuleDestroy();
    assert.deepEqual(calls,[]);assert.equal(JSON.stringify([...persisted]),before);
    // Changing env cannot release the value already used by the actual modules.
    delete process.env.IAM_AUTOMATION_HOLD;await refused(()=>wf.start());await engine.onModuleInit();assert.deepEqual(calls,[]);
  `, '1', { IAM_DATA_MIGRATIONS:'1', IAM_EFFECTS:'1', IAM_PG_URL:'postgres://invalid', IAM_RECONCILE_INTERVAL_MS:'200', IAM_AUTO_ACTIVATE_MAIN:'1', IAM_WORKFLOW_REAL_CONNECTIONS:'1' });
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
});

it('held HTTP routes use real Nest routing and guard order with no business handler access', () => {
  const base = new URL('../', import.meta.url).href;
  const r = run(`
    import assert from 'node:assert/strict';
    import {Test} from '@nestjs/testing';
    import request from 'supertest';
    import {UnauthorizedException,ForbiddenException} from '@nestjs/common';
    const load=p=>import(${JSON.stringify(base)}+p+'.js');
    await load('plugins/v1/registry');
    const {PluginRegistry}=await load('plugins/v1/registry');
    const {AuthGuard}=await load('auth/auth.guard');
    const {AdminGuard}=await load('auth/admin.guard');
    const {WorkflowsEnabledGuard}=await load('workflows/workflows-enabled.guard');
    const {WorkflowsController}=await load('workflows/workflows.controller');
    const {WorkflowHooksController}=await load('workflows/hooks.controller');
    const {WorkflowTasksController}=await load('workflows/tasks.controller');
    const {WorkflowConnectionsController}=await load('workflows/connections.controller');
    const {WorkflowsService}=await load('workflows/workflows.service');
    const {WorkflowTasksService}=await load('workflows/tasks');
    const {WorkflowConnections}=await load('workflows/connections');
    const {WorkflowStore}=await load('workflows/store');
    let accesses=0;
    const blocked=Object.fromEntries(['start','fire','decide','delegate','testDraft','test','getDefinition','save','remove'].map(key=>[key,()=>{accesses++;throw Error('business access '+key);} ]));
    globalThis.fetch=async()=>{throw Error('external network forbidden')};
    const fixtureAuth={canActivate:ctx=>{const req=ctx.switchToHttp().getRequest();if(req.headers.authorization!=='Bearer fixture')throw new UnauthorizedException();req.user={sub:'fixture',tenant:'demo'};if(req.params.tenant!=='demo')throw new ForbiddenException();return true;}};
    const mod=await Test.createTestingModule({controllers:[WorkflowsController,WorkflowHooksController,WorkflowTasksController,WorkflowConnectionsController],providers:[AuthGuard,AdminGuard,WorkflowsEnabledGuard,{provide:PluginRegistry,useValue:{isActive:()=>true}},{provide:WorkflowStore,useValue:blocked},{provide:WorkflowsService,useValue:blocked},{provide:WorkflowTasksService,useValue:blocked},{provide:WorkflowConnections,useValue:blocked}]}).overrideGuard(AuthGuard).useValue(fixtureAuth).compile();
    const app=mod.createNestApplication();await app.init();
    try {
      const server=app.getHttpServer();const path='/tenants/demo/workflows/fixture/runs';
      assert.equal((await request(server).post(path)).status,401);
      assert.equal((await request(server).post(path).set('authorization','Bearer fixture')).status,403);
      assert.equal((await request(server).post(path).set('authorization','Bearer fixture').set('x-api-admin-token','fictional-admin-capability')).status,503);
      assert.equal((await request(server).post('/tenants/demo/workflow-hooks/fixture/token').send({})).status,503);
      for(const route of ['workflow-tasks/task/decision','workflow-tasks/task/delegate'])assert.equal((await request(server).post('/tenants/demo/'+route).set('authorization','Bearer fixture').send({})).status,503);
      for(const route of ['workflow-connections/probe','workflow-connections/id/test'])assert.equal((await request(server).post('/tenants/demo/'+route).set('authorization','Bearer fixture').set('x-api-admin-token','fictional-admin-capability').send({})).status,503);
      assert.equal(accesses,0);
    } finally {await app.close();}
  `, '1', {IAM_API_ADMIN_TOKEN:'fictional-admin-capability',IAM_API_ADMIN_SUBJECTS:'fixture',IAM_SCREEN_ACCESS:'0'});
  assert.equal(r.status,0,r.stdout+'\n'+r.stderr);
});
