// Executed inside an isolated helper container (capture) or candidate (smoke).
// Private auth and Bao tokens never leave this process or appear in stdout.
import {execFileSync} from 'node:child_process';
import {readFileSync,cpSync,mkdtempSync,existsSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
let diagnosticStage='init';
const [mode]=process.argv.slice(1);let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>262144)throw Error('input bound');}const p=JSON.parse(raw);
const json=async(url,options={})=>{
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(r.status!==200||!/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''))throw Error('non-200 or non-JSON response');
 return r.json();
};
async function bao(){
 const base=p.baoAddress,token=p.baoToken;
 if(!base||!token||!Array.isArray(p.baoMetadataRoots)||!p.baoMetadataRoots.length)throw Error('Bao metadata coverage/auth missing');
 const status=await json(base+'/v1/sys/health');if(status.sealed!==false)throw Error('Bao sealed/unknown');
 const found={};let seen=0;
 async function walk(path){
  if(++seen>10000)throw Error('Bao inventory bound');
  const result=await json(base+'/v1/'+path,{method:'LIST',headers:{'X-Vault-Token':token}});
  if(!Array.isArray(result.data?.keys))throw Error('Bao LIST unknown');
  for(const key of result.data.keys.sort()){
   if(typeof key!=='string'||key.includes('..'))throw Error('Bao metadata key');
   if(key.endsWith('/'))await walk(path+'/'+key.slice(0,-1));
   else {const data=await json(base+'/v1/'+path+'/'+encodeURIComponent(key),{headers:{'X-Vault-Token':token}});if(!Number.isInteger(data.data?.current_version))throw Error('Bao metadata invalid');found[path+'/'+key]=hash(JSON.stringify(data.data));}
  }
 }
 for(const root of p.baoMetadataRoots){if(!/^[a-zA-Z0-9_/-]+\/metadata\/[a-zA-Z0-9_/-]+$/.test(root))throw Error('invalid Bao root');await walk(root);}
 return found;
}
function dolt(){
 const dir=p.running?'/data/dolt':mkdtempSync('/tmp/qualification-')+'/dolt';
 if(!p.running)cpSync('/data/dolt',dir,{recursive:true,errorOnExist:true});
 const query=(db,sql)=>{const r=JSON.parse(execFileSync('dolt',[...(p.running?['--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','']:[]),...(db?['--use-db='+db]:[]),'sql','-r','json','-q',sql],{cwd:dir,encoding:'utf8',maxBuffer:64*1024*1024}));if(!Array.isArray(r.rows))throw Error('Dolt inventory unknown');return r.rows;};
 const dbs=query('','SHOW DATABASES').map(r=>Object.values(r)[0]).filter(n=>!['information_schema','mysql','dolt_cluster'].includes(n)).sort();
 if(!dbs.includes('iam'))throw Error('business database absent');
 return dbs.flatMap(db=>query(db,'SELECT name, hash FROM dolt_branches ORDER BY name').map(b=>{
  const rows=query(db+'/'+b.name,"SELECT DOLT_HASHOF_DB('WORKING') AS root");if(!rows[0]?.root)throw Error('Dolt working root unknown');return {database:db,branch:b.name,head:b.hash,root:rows[0].root};
 }));
}
async function workflowHashes(){
 const {createRequire}=await import('node:module');const require=createRequire('/app/api/package.json');const{createConnection}=require('mysql2/promise');
 const c=await createConnection({host:'127.0.0.1',port:3307,user:'root',database:'iam_meta',dateStrings:true});const result={};
 try{for(const db of ['iam','iam_meta']){const[tables]=await c.query('SHOW TABLES FROM '+db);for(const row of tables){const name=String(Object.values(row)[0]);if(!/^workflow_[a-z_]+$/.test(name))continue;const[rows]=await c.query('SELECT * FROM '+db+'.'+name);result[db+'.'+name]=hash(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort()));}}return result;}finally{await c.end();}
}
async function smoke(){
 const local='http://127.0.0.1:8080';
 diagnosticStage='smoke-hold';
 if(p.requireAutomationHold===true){const log=readFileSync('/data/api.log','utf8');const match=/automation hold: (\{[^\n]+\})/.exec(log);if(!match||JSON.parse(match[1]).held!==true||process.env.IAM_AUTOMATION_HOLD!=='1')throw Error('captured automation hold absent');if(!(await fetch('http://127.0.0.1:3000/health')).ok)throw Error('API health failed');}
 diagnosticStage='smoke-health';
 if(!(await fetch(local+'/healthz')).ok)throw Error('edge health failed');
 diagnosticStage='smoke-workflows-before';
 const workflowBefore=p.requireAutomationHold===true?await workflowHashes():null;
 diagnosticStage='smoke-auth-input';
 const credentials=p.auth;
 if(typeof credentials.username!=='string'||typeof credentials.password!=='string')throw Error('auth input missing');
 let journal;
 for(const origin of p.origins){
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(16).toString('hex');
  const params=new URLSearchParams({client_id:'demo-web',redirect_uri:origin+'/callback',response_type:'code',state,code_challenge:challenge,code_challenge_method:'S256',chain:'password-only'});
  diagnosticStage='smoke-oidc-form';
  const page=await fetch(local+'/core/authorize?'+params,{redirect:'manual'}),html=await page.text();
  if(page.status!==200||!html.includes('name="username"'))throw Error('expected origin/form refused');
  const fields={};for(const m of html.matchAll(/<input\b[^>]*>/gi)){const tag=m[0],name=tag.match(/\bname="([^"]+)"/i)?.[1],value=tag.match(/\bvalue="([^"]*)"/i)?.[1]??'';if(name&&!['username','password'].includes(name))fields[name]=value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
  fields.username=credentials.username;fields.password=credentials.password;
  diagnosticStage='smoke-oidc-login';
  const logged=await fetch(local+'/core/authorize/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie:page.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')},body:new URLSearchParams(fields)});
  if(logged.status!==302)throw Error('real OIDC login failed');
  const location=new URL(logged.headers.get('location')??'');if(location.origin!==origin||location.pathname!=='/callback'||location.searchParams.get('state')!==state||!location.searchParams.get('code'))throw Error('OIDC redirect/state failed');
  diagnosticStage='smoke-oidc-token';
  const issued=await json(local+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:location.searchParams.get('code'),code_verifier:verifier,redirect_uri:origin+'/callback',client_id:'demo-web'})});
  if(typeof issued.id_token!=='string')throw Error('token absent');
  const claims=JSON.parse(Buffer.from(issued.id_token.split('.')[1],'base64url').toString());
  if(claims.iss!==p.issuer||!(claims.aud==='demo-web'||Array.isArray(claims.aud)&&claims.aud.includes('demo-web')))throw Error('issuer/audience mismatch');
  diagnosticStage='smoke-oidc-session';
  const session=await fetch(local+'/core/session/extend',{method:'POST',headers:{authorization:'Bearer '+issued.id_token}});if(![200,409].includes(session.status))throw Error('session token verification failed');
  diagnosticStage='smoke-activations';
  const rows=await json(local+'/api/tenants/'+encodeURIComponent(p.tenant)+'/activations',{headers:{authorization:'Bearer '+issued.id_token}});
  if(!Array.isArray(rows))throw Error('journal unknown');let seq=0;
  for(const row of rows){if(row.tenant!==p.tenant||!Number.isSafeInteger(row.seq)||row.seq<=seq||typeof row.commit!=='string'||!row.commit||!['pending','recorded','applied','failed'].includes(row.state))throw Error('journal schema invalid');seq=row.seq;}
  journal={count:rows.length,checksum:hash(JSON.stringify(rows))};
 }
 diagnosticStage='smoke-negative-redirect';
 const negative=await fetch(local+'/core/authorize?'+new URLSearchParams({client_id:'demo-web',redirect_uri:'https://example.invalid/callback',response_type:'code',state:'negative',code_challenge:'A'.repeat(43),code_challenge_method:'S256'}));
 if(!/unknown client/i.test(await negative.text()))throw Error('negative redirect check failed');
 diagnosticStage='smoke-workflows-after';
 if(workflowBefore&&JSON.stringify(await workflowHashes())!==JSON.stringify(workflowBefore))throw Error('workflow state changed during held smoke');
 diagnosticStage='smoke-ledger';
 if(p.reviewedLegacyRollback===true&&!existsSync('/data/migrations/journal.json')&&!existsSync('/app/migration-source/data/migrations/manifest.json'))return {journal,ledger:'legacy-rollback-no-migration-ledger'};
 const ledger=JSON.parse(readFileSync('/data/migrations/journal.json','utf8'));
 if(ledger.format!==1||ledger.pending||!Array.isArray(ledger.entries)||!ledger.entries.length)throw Error('migration ledger incomplete');
 const expected=JSON.parse(readFileSync('/app/migration-source/data/migrations/manifest.json','utf8'));
 if(expected.versions.length!==ledger.entries.length||expected.versions.some((v,i)=>v.id!==ledger.entries[i].id||v.checksum!==ledger.entries[i].checksum))throw Error('migration history mismatch');
 return {journal,held:p.requireAutomationHold===true,workflowPreserved:workflowBefore!==null,ledger:ledger.entries.map(e=>({id:e.id,checksum:e.checksum}))};
}
try{
 if(mode==='capture'){diagnosticStage='capture-dolt';const d=dolt();diagnosticStage='capture-bao';const b=await bao();console.log(JSON.stringify({dolt:d,bao:b}));}
 else if(mode==='held-state-check'){
  const log=readFileSync('/data/api.log','utf8');const captured=/automation hold: (\{[^\n]+\})/.exec(log);
  if(process.env.IAM_AUTOMATION_HOLD!=='1'||!captured||JSON.parse(captured[1]).held!==true)throw Error('captured hold required');
  const hashes=await workflowHashes();if(!Object.keys(hashes).length)throw Error('workflow coverage empty');
  console.log(JSON.stringify({held:true,hashes}));
 }
 else if(mode==='smoke')console.log(JSON.stringify(await smoke()));
 else throw Error('invalid mode');
}catch{console.error('QUALIFICATION_DIAG_V1:'+diagnosticStage);console.error('Qualification UNKNOWN or failed. Preserve private evidence and keep maintenance armed.');process.exitCode=1;}
