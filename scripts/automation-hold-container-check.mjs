#!/usr/bin/env node
// Qualification only: synthetic Docker volumes, network none, no host ports or credentials.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const image=process.argv[2]||'iam-demo:ci',out=process.argv[3]||'/tmp/automation-hold-proof';
mkdirSync(out,{recursive:true});
const prefix=`hold-proof-${process.pid}`,base=`${prefix}-base`,copy=`${prefix}-copy`,containers=[];
function docker(args,{input,allowFailure=false,timeoutMs=180000}={}) {
 const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:timeoutMs,maxBuffer:16*1024*1024});
 if(!allowFailure)assert.equal(r.status,0,`docker ${args[0]} failed: ${r.stderr}\n${r.stdout}`);
 return r;
}
function exec(name,code,timeoutMs=180000){return docker(['exec','-i',name,'node','--input-type=module','-'],{input:code,timeoutMs}).stdout;}
function save(name,value){const text=typeof value==='string'?value:JSON.stringify(value,null,2);assert.ok(!/Bearer\s+[A-Za-z0-9._~-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(text),'refusing artifact with bearer/JWT material');writeFileSync(`${out}/${name}`,text);}
function logSummary(name){
 return exec(name,String.raw`
import{readFileSync,readdirSync}from'node:fs';
const log=readFileSync('/data/api.log','utf8');const secrets=[];
for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const cmd=readFileSync('/proc/'+pid+'/cmdline','utf8');if(!cmd.includes('dist/main.js'))continue;for(const item of readFileSync('/proc/'+pid+'/environ','utf8').split('\0')){const i=item.indexOf('=');if(i>0&&/TOKEN|PASSWORD|SECRET/.test(item.slice(0,i))&&item.slice(i+1).length>=8)secrets.push(item.slice(i+1));}}catch{}}
if(secrets.some(secret=>log.includes(secret))||/Bearer\s+[A-Za-z0-9._~-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i.test(log))throw Error('API log contains sensitive material; no log artifact emitted');
const match=/automation hold: (\{[^\n]+\})/.exec(log);const state=match?JSON.parse(match[1]):null;
console.log(JSON.stringify({capturedHold:state?{held:state.held,settingPresent:state.settingPresent,restartRequired:state.restartRequired}:null,cronStarted:(log.match(/started run /g)||[]).length,cronWarnings:(log.match(/cron of /g)||[]).length,secretScanPassed:true,rawLogExported:false}));
`);
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function start(name,volume,held,seed='never'){
 containers.push(name);
 const args=['run','-d','--network','none','--memory','512m','--name',name,'-v',`${volume}:/data`,'-e',`IAM_DEMO_SEED_MODE=${seed}`];
 if(held)args.push('-e','IAM_AUTOMATION_HOLD=1');
 const fifo='/tmp/lyam-closed-start.fifo';const guard='set -eu; rm -f '+fifo+'; mkfifo -m 600 '+fifo+'; read -r permit < '+fifo+'; [ "$permit" = start-held ]; rm -f '+fifo+'; exec sh /app/demo/start.sh';
 args.push('--restart','no','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','sh',image,'-c',guard);docker(args);
 let fifoReady=false;for(let i=0;i<50;i++){if(docker(['exec',name,'sh','-c','test -p '+fifo],{allowFailure:true}).status===0){fifoReady=true;break;}await pause(100);}assert.ok(fifoReady,'fresh FIFO must exist before release');
 docker(['exec',name,'sh','-c','printf "%s\\n" start-held > '+fifo]);
 const info=JSON.parse(docker(['inspect',name]).stdout)[0];assert.equal(info.HostConfig.NetworkMode,'none');assert.equal(info.HostConfig.RestartPolicy.Name,'no');assert.ok(info.HostConfig.CapDrop.includes('ALL'));assert.ok(info.HostConfig.SecurityOpt.some(x=>x.startsWith('no-new-privileges')));assert.ok(!info.HostConfig.PortBindings||Object.keys(info.HostConfig.PortBindings).length===0);
 for(let i=0;i<90;i++){
  const r=docker(['exec',name,'node','-e',"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{allowFailure:true});
  if(r.status===0){const edge=docker(['exec',name,'node','-e',"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{allowFailure:true});if(edge.status===0)return;}await pause(2000);
 }
 throw Error(`API did not become healthy in ${name}`);
}
const tableHashCode=String.raw`
import {createHash} from 'node:crypto';
async function tableHashes(c){const result={};const quoted=s=>String.fromCharCode(96)+s.replaceAll(String.fromCharCode(96),String.fromCharCode(96,96))+String.fromCharCode(96);for(const db of ['iam','iam_meta']){const [tables]=await c.query('SHOW TABLES FROM '+quoted(db));for(const row of tables){const table=Object.values(row)[0];const [rows]=await c.query('SELECT * FROM '+quoted(db)+'.'+quoted(table));result[db+'.'+table]=createHash('sha256').update(JSON.stringify(rows.map(x=>JSON.stringify(x)).sort())).digest('hex');}}return result;}
`;
// The fixture module runs in a temporary isolated container with only its own Dolt process.
const fixture=tableHashCode+String.raw`
import {spawn,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire('/app/api/package.json'),{createConnection}=require('mysql2/promise');require('reflect-metadata');
const identity=spawnSync('dolt',['config','--global','--add','user.name','synthetic-proof'],{encoding:'utf8'});assert.equal(identity.status,0);assert.equal(spawnSync('dolt',['config','--global','--add','user.email','synthetic@example.invalid'],{encoding:'utf8'}).status,0);
const child=spawn('dolt',['sql-server','-H','127.0.0.1','-P','3307'],{cwd:'/data/dolt',stdio:'ignore'});
let connection;
try{
 for(let i=0;i<100;i++){try{connection=await createConnection({host:'127.0.0.1',port:3307,user:'root',database:'iam',dateStrings:true});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.ok(connection,'fixture Dolt readiness');
 process.env.DOLT_HOST='127.0.0.1';process.env.DOLT_PORT='3307';process.env.DOLT_DATABASE='iam';process.env.IAM_WORKSPACE_MODE='1';
 const {WorkflowStore}=await import('/app/api/dist/workflows/store.js');
 const {VersioningService}=await import('/app/api/dist/versioning/versioning.service.js');
 const store=new WorkflowStore(new VersioningService());
 await store.prepareMigrationStorage();
 const at='2026-01-01 00:00:00',tenant='acme-demo';
 const graph={nodes:[{id:'mail',type:'lyam-send-mail',name:'Synthetic mail',config:{to:'nobody@example.invalid',subject:'Synthetic proof',text:'Network isolated'}}],edges:[]};
 for(const [id,trigger] of [['proof-cron',{cron:'* * * * *'}],['proof-event',{event:'user.created',match:{subject:'proof-only'}}],['proof-hook',{event:'http.webhook-received',config:{token:'fictional-proof-token'}}]]){
  await store.putDefinition({id,tenant,name:id,description:'isolated qualification only',graph,trigger,active:true,tags:[],created_by:'proof',created_at:at,updated_at:at},'main');
 }
 // Baseline synthetic seeds may be active. Leave them intact, including the legacy simulated sheet poller.
 for(const [id,status,started_by] of [['proof-queued','queued','proof'],['proof-running','running','proof'],['proof-parent','waiting','proof'],['proof-child','queued','workflow:proof-parent']]){
  await store.createRun({id,tenant,definition_id:'proof-cron',name:id,graph,branch:null,base_branch:'main',status,error:null,started_by,started_at:at,finished_at:null,test:false},[{run_id:id,node_id:'mail',status:'pending',simulated:false,attempts:0,error:null,log:[],input:null,output:null,started_at:null,finished_at:null}]);
 }
 await store.putTask({id:'proof-task',tenant,kind:'approval',title:'Retained synthetic task',detail:{},assignee:'demo-alice',delegated_to:null,status:'open',decision:null,justification:null,decided_by:null,run_id:'proof-parent',node_id:'mail',prevent_self:false,created_at:at,due_at:null,reminded_at:null,decided_at:null});
 await store.setMeta('cron-fired:acme-demo:proof-cron','previous-minute');
 // Force a legitimate synthetic main change after seeding, so unheld MainPublication has something to apply.
 await connection.query("INSERT INTO roles(id,label,is_sensitive) VALUES('proof-role','Synthetic proof role',false)");
 await connection.query("CALL DOLT_ADD('-A')");await connection.query("CALL DOLT_COMMIT('-m','synthetic qualification only')");
 const retained={};for(const table of ['workflow_runs','workflow_steps','workflow_tasks','workflow_store_meta']){const [rows]=await connection.query('SELECT * FROM iam_meta.'+table);retained[table]=rows.map(x=>JSON.stringify(x)).sort();}
 const [defs]=await connection.query('SELECT * FROM workflow_definitions');retained.definitions=defs.map(x=>JSON.stringify(x)).sort();retained.tableHashes=await tableHashes(connection);console.log(JSON.stringify(retained));
}finally{await connection?.end();if(child.exitCode===null){const closed=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await closed;}}
`;
const snapshot=tableHashCode+String.raw`
import {createRequire}from'node:module';const require=createRequire('/app/api/package.json');
const {createConnection}=require('mysql2/promise');const c=await createConnection({host:'127.0.0.1',port:3307,user:'root',database:'iam_meta',dateStrings:true});
const result={};try{for(const table of ['workflow_runs','workflow_steps','workflow_tasks','workflow_store_meta']){const [rows]=await c.query('SELECT * FROM '+table);result[table]=rows.map(x=>JSON.stringify(x)).sort();}
 const [defs]=await c.query('SELECT * FROM iam.workflow_definitions');result.definitions=defs.map(x=>JSON.stringify(x)).sort();
 result.tableHashes=await tableHashes(c);
 const version=await fetch('http://127.0.0.1:8081/v1/version?tenant=acme-demo');result.coreVersion=version.ok?await version.json():{status:version.status};
 console.log(JSON.stringify(result));}finally{await c.end();}
`;
try{
 docker(['volume','create',base]);docker(['volume','create',copy]);
 await start(`${prefix}-seed`,base,false,'auto');
 const seedVersion=JSON.parse(exec(`${prefix}-seed`,"const r=await fetch('http://127.0.0.1:8081/v1/version?tenant=acme-demo');if(!r.ok)throw Error('seed core version unavailable: '+r.status);console.log(JSON.stringify(await r.json()));"));
 docker(['stop','-t','20',`${prefix}-seed`]);
 containers.push(`${prefix}-fixture`);const baseline=JSON.parse(docker(['run','--rm','--name',`${prefix}-fixture`,'-i','--network','none','-v',`${base}:/data`,'--entrypoint','node',image,'--input-type=module','-'],{input:fixture}).stdout.trim().split('\n').at(-1));save('fixture-baseline.json',baseline);
 // Copy a stopped, coherent synthetic volume. Neither side contains production data.
 containers.push(`${prefix}-copy-job`);docker(['run','--rm','--name',`${prefix}-copy-job`,'--network','none','-v',`${base}:/source:ro`,'-v',`${copy}:/target`,'--entrypoint','sh',image,'-c','cp -a /source/. /target/']);
 await start(`${prefix}-held`,base,true);
 const heldName=`${prefix}-held`;
 const before=JSON.parse(exec(heldName,snapshot));save('held-before.json',before);
 save('held-startup-table-changes.json',Object.keys({...baseline.tableHashes,...before.tableHashes}).filter(t=>baseline.tableHashes[t]!==before.tableHashes[t]));
 for(const key of Object.keys(baseline).filter(k=>k!=='tableHashes'))assert.deepEqual(before[key],baseline[key],`held startup changed ${key}`);assert.deepEqual(before.coreVersion,seedVersion,'held startup activated synthetic changed head');
 const probes=exec(heldName,String.raw`
import assert from 'node:assert/strict';import {readFileSync,readdirSync}from'node:fs';
const log=readFileSync('/data/api.log','utf8');assert.match(log,/automation hold:.*"held":true/);
const hook=await fetch('http://127.0.0.1:3000/tenants/acme-demo/workflow-hooks/proof-hook/fictional-proof-token',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(hook.status,503);
// API environment contains only this synthetic container's per-boot random capability. Never print it.
let apiEnv;for(const pid of readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const cmd=readFileSync('/proc/'+pid+'/cmdline','utf8');if(cmd.includes('dist/main.js')){apiEnv=Object.fromEntries(readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)];}));break;}}catch{}}
assert.ok(apiEnv?.IAM_API_ADMIN_TOKEN);
// Real PKCE sign-in, then authenticated API probes. Synthetic credentials only, never output tokens.
const {createHash}=await import('node:crypto');const verifier='synthetic-proof-verifier-012345678901234567890123456789';const challenge=createHash('sha256').update(verifier).digest('base64url');const redirect='http://localhost:8080/callback';
const params=new URLSearchParams({response_type:'code',client_id:'demo-web',redirect_uri:redirect,state:'synthetic-proof-state',code_challenge:challenge,code_challenge_method:'S256',chain:'password-only'});
const auth=await fetch('http://127.0.0.1:8080/core/authorize?'+params);assert.equal(auth.status,200);assert.match(await auth.text(),/authorize\/login/);
const login=await fetch('http://127.0.0.1:8080/core/authorize/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...Object.fromEntries(params),username:'demo-alice',password:'demo-only-not-a-secret'})});assert.equal(login.status,302);const redirectUrl=new URL(login.headers.get('location'),'http://localhost:8080');assert.equal(redirectUrl.searchParams.get('state'),'synthetic-proof-state');const code=redirectUrl.searchParams.get('code');assert.ok(code);
const tokenReply=await fetch('http://127.0.0.1:8080/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,code_verifier:verifier,redirect_uri:redirect,client_id:'demo-web'})});assert.equal(tokenReply.status,200);const tokens=await tokenReply.json();const bearer=tokens.id_token||tokens.access_token;assert.ok(bearer);
const extended=await fetch('http://127.0.0.1:8080/core/session/extend',{method:'POST',headers:{authorization:'Bearer '+bearer}});assert.ok([200,409].includes(extended.status),'smoke session verification must pass');
const headers={authorization:'Bearer '+bearer,'x-api-admin-token':apiEnv.IAM_API_ADMIN_TOKEN,'x-iam-branch':'main','content-type':'application/json'};
assert.equal((await fetch('http://127.0.0.1:3000/tenants/acme-demo/workflows/proof-cron/runs',{method:'POST',headers})).status,503);
assert.equal((await fetch('http://127.0.0.1:3000/tenants/acme-demo/workflow-runs',{headers})).status,200);
assert.equal((await fetch('http://127.0.0.1:3000/health')).status,200);
const activations=await fetch('http://127.0.0.1:3000/tenants/acme-demo/activations',{headers});assert.equal(activations.status,200);assert.ok(Array.isArray(await activations.json()));
console.log(JSON.stringify({health:200,webhook:hook.status,capturedHold:true,authenticatedRunWrite:503,runRead:200,sessionExtend:extended.status,activationRead:200}));
`);save('held-probes.json',probes);
 const qualifiedSource=readFileSync('deploy/oci/qualification-container.mjs','utf8');
 const heldState=()=>JSON.parse(docker(['exec','-i',heldName,'node','--input-type=module','-e',qualifiedSource,'held-state-check'],{input:'{}'}).stdout);
 const qualifiedBefore=heldState();save('qualification-real-workflow-hashes-before.json',qualifiedBefore);
 await pause(25000);const after=JSON.parse(exec(heldName,snapshot));save('held-after.json',after);
 save('held-probes-table-changes.json',Object.keys({...before.tableHashes,...after.tableHashes}).filter(t=>before.tableHashes[t]!==after.tableHashes[t]));
 for(const key of ['workflow_runs','workflow_steps','workflow_tasks','workflow_store_meta','definitions','coreVersion'])assert.deepEqual(after[key],before[key],`held ${key} changed`);
 const certDir=mkdtempSync(join(tmpdir(),'hold-proof-cert-'));
 try{
  const generated=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-days','1','-nodes','-subj','/CN=localhost'],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
  const tls=exec(heldName,`import assert from 'node:assert/strict';import{createServer}from'node:https';await import('/app/api/dist/security/tls-policy.js');const server=createServer({key:${JSON.stringify(readFileSync(join(certDir,'key.pem'),'utf8'))},cert:${JSON.stringify(readFileSync(join(certDir,'cert.pem'),'utf8'))}},(_q,r)=>r.end('unexpected'));await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await assert.rejects(()=>fetch('https://127.0.0.1:'+server.address().port),e=>/CERT|SELF_SIGNED/.test(String(e.cause?.code)));console.log('PASS self-signed rejected by separate Node process defaults; dist TLS guard imported, native packages not loaded, application process policy not proved');}finally{await new Promise(r=>server.close(r));}`);save('held-tls.log',tls);
 }finally{rmSync(certDir,{recursive:true,force:true});}
 const qualifiedAfter=heldState();assert.deepEqual(qualifiedAfter,qualifiedBefore,'real qualification SQL hashes/log hold changed');save('qualification-real-workflow-hashes-after.json',qualifiedAfter);
 save('held-api-summary.json',logSummary(heldName));
 docker(['stop','-t','20',heldName]);
 await start(`${prefix}-unheld`,copy,false);
 const marker=state=>state.workflow_store_meta.find(x=>JSON.parse(x).k==='cron-fired:acme-demo:proof-cron');let witness;const deadline=Date.now()+90000;
 do{witness=JSON.parse(exec(`${prefix}-unheld`,snapshot,Math.max(1,deadline-Date.now())));if(marker(witness)!==marker(before)&&JSON.stringify(witness.coreVersion)!==JSON.stringify(before.coreVersion)&&JSON.stringify(witness.workflow_runs)!==JSON.stringify(before.workflow_runs))break;await pause(Math.min(3000,Math.max(0,deadline-Date.now())));}while(Date.now()<deadline);
 save('unheld-after.json',witness);
 assert.notEqual(marker(witness),marker(before),'unheld cron must update retained marker within90s');
 assert.notDeepEqual(witness.workflow_runs,before.workflow_runs,'unheld witness must attempt workflow resumption/arming within90s');
 assert.notDeepEqual(witness.coreVersion,before.coreVersion,'unheld MainPublication must apply the synthetic changed head within90s');
 save('unheld-api-summary.json',logSummary(`${prefix}-unheld`));
 for(const [key,value] of [['IAM_AUTOMATION_HOLD','0'],['NODE_TLS_REJECT_UNAUTHORIZED','0']]){
  const invalidName=`${prefix}-invalid-${key.toLowerCase()}`;containers.push(invalidName);const r=docker(['run','--rm','--name',invalidName,'--network','none','-e',`${key}=${value}`,'--entrypoint','node',image,'/app/api/dist/main.js'],{allowFailure:true});
  assert.equal(r.error,undefined,`${key} refusal must not time out`);assert.equal(r.signal,null,`${key} refusal must exit itself`);assert.ok(Number.isInteger(r.status)&&r.status>0,`${key} invalid value must refuse boot`);assert.match(r.stderr+r.stdout,key==='IAM_AUTOMATION_HOLD'?/IAM_AUTOMATION_HOLD/:/TLS certificate verification/);save(`invalid-${key}.log`,r.stderr+r.stdout);
 }
 save('result.json',{passed:true,image,network:'none',syntheticOnly:true,nativePiecesTLS:'not exercised in container',selfSignedTLS:'separate Node defaults only, not API or native-piece process policy',pgEffects:'not exercised, memory journal only',eventBusDelivery:'not injected; consumer absence only indirect',productionQueue:'not exercised',authenticatedAppModuleRoutes:'real synthetic PKCE and API guards',globalZeroWrites:false});
 console.log('PASS isolated full AppModule hold and synthetic unheld witness');
}finally{
 for(const name of containers.filter(n=>/-seed$|-held$|-unheld$/.test(n))){try{save(name+'-api-final-summary.json',logSummary(name));}catch{console.error('No safe API log summary available for '+name);}}
 for(const name of containers)docker(['rm','-f',name],{allowFailure:true});
 for(const volume of [base,copy])docker(['volume','rm',volume],{allowFailure:true});
}
