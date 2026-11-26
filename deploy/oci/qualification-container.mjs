// Executed inside an isolated helper container (capture) or candidate (smoke).
// Private auth and Bao tokens never leave this process or appear in stdout.
import {execFileSync} from 'node:child_process';
import {readFileSync,cpSync,mkdtempSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
let diagnosticStage='init';
const [mode]=process.argv.slice(1);let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>262144)throw Error('input bound');}const p=JSON.parse(raw);
const json=async(url,options={},activationDiagnostic=false)=>{
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(r.status!==200||!/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''))throw Error('non-200 or non-JSON response');
 if(activationDiagnostic)diagnosticStage='smoke-activations-parse';
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
 // Offline Dolt may create global state under HOME even for read-only SQL.
 // Keep that state on helper tmpfs, never on the read-only image or source mount.
 const queryEnv=p.running?process.env:{...process.env,HOME:mkdtempSync('/tmp/qualification-home-')};
 if(!p.running){mkdirSync(queryEnv.HOME+'/.dolt',{recursive:true});writeFileSync(queryEnv.HOME+'/.dolt/config_global.json',JSON.stringify({'metrics.disabled':'true'}),{mode:0o600});}
 const query=(db,sql)=>{try{const r0=JSON.parse(execFileSync('dolt',[...(p.running?['--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','']:[]),...(db?['--use-db='+db]:[]),'sql','-r','json','-q',sql],{cwd:dir,env:queryEnv,encoding:'utf8',maxBuffer:64*1024*1024}));const r=r0&&typeof r0==='object'&&!Array.isArray(r0)&&Object.keys(r0).length===0?{rows:[]}:r0;   // dolt prints {} for a strictly empty result (compat fix shared with the producer)
 if(!r||!Array.isArray(r.rows))throw Error('Dolt inventory unknown');return r.rows;}catch(e){const kinds=['SHOW DATABASES','SELECT name, hash','SELECT DOLT_HASHOF_DB','SELECT DATABASE()','SHOW FULL TABLES','SHOW FULL COLUMNS','SHOW CREATE VIEW','SHOW KEYS','SHOW CREATE TABLE','SELECT DOLT_HASHOF_TABLE','SELECT COUNT(*)','SELECT * FROM dolt_schemas','SELECT * FROM dolt_procedures','SELECT table_name'];const diagnosticText=String(e?.stderr||'')+' '+String(e?.stdout||'')+' '+String(e?.message||'');const failurePatterns=[/read.only file system/i,/permission denied|EACCES|EPERM/i,/no space left|ENOSPC/i,/operation not permitted/i,/lock|another server/i,/failed to map|executable|noexec/i,/not found|ENOENT/i,/configuration|config.*directory|home directory/i,/connection refused/i,/runtime|panic|fatal error/i];console.error('DOLT_ERROR_MASK_V1:'+failurePatterns.reduce((n,r,i)=>n+(r.test(diagnosticText)?2**i:0),0));console.error('DOLT_THREAD_FAILURE_V1:'+(String(e?.stderr||'').includes('pthread_create failed')?1:0));console.error('DOLT_QUERY_KIND_V1:'+kinds.findIndex(k=>sql.startsWith(k)));throw e;}};
 const dbs=query('','SHOW DATABASES').map(r=>Object.values(r)[0]).filter(n=>!['information_schema','mysql','dolt_cluster'].includes(n)).sort();
 if(!dbs.includes('iam'))throw Error('business database absent');
 // Per-table evidence, hash/shape only (no row content): exact table inventory with kind, column shape, primary key order, row count and
 // Dolt's own table hash (schema + data) at the WORKING root of every database/branch. Table names are identifiers, never data.
 const ident=/^[A-Za-z0-9_]{1,64}$/;
 const tableEvidence=ref=>query(ref,'SHOW FULL TABLES').map(r=>{const tk=Object.keys(r).filter(k=>/^Tables_in_/.test(k));if(tk.length!==1||typeof r.Table_type!=='string')throw Error('Dolt table listing shape unknown');   // JSON keys are alphabetical: never positional
  const name=String(r[tk[0]]),kind=r.Table_type;
  if(!ident.test(name))throw Error('Dolt table identifier unsafe');
  // Defaults and comments can carry user-chosen text: only NULL-ness plus a sha256 are kept, never the raw value.
  const columns=query(ref,'SHOW FULL COLUMNS FROM `'+name+'`').map(c=>({name:String(c.Field),type:String(c.Type),nullable:String(c.Null),key:String(c.Key),collation:c.Collation===null||c.Collation===undefined?null:String(c.Collation),defaultIsNull:c.Default===null||c.Default===undefined,defaultHash:hash(JSON.stringify(c.Default===null||c.Default===undefined?{k:'null'}:{k:'value',type:String(c.Type),v:String(c.Default)})),extra:String(c.Extra||''),commentHash:hash(String(c.Comment||''))}));
  if(kind==='VIEW'){const cv=query(ref,'SHOW CREATE VIEW `'+name+'`');if(typeof cv[0]?.['Create View']!=='string')throw Error('Dolt view DDL unknown');const d=hash(cv[0]['Create View']);return {name,kind,columns,pk:[],indexes:[],rows:null,ddlHash:d,hash:d};}
  if(kind!=='BASE TABLE')throw Error('Dolt table kind unknown');
  const keys=query(ref,'SHOW KEYS FROM `'+name+'`');
  const indexes=keys.map(k=>({name:String(k.Key_name),nonUnique:Number(k.Non_unique),seq:Number(k.Seq_in_index),column:k.Column_name===null||k.Column_name===undefined?null:String(k.Column_name),collation:k.Collation===null||k.Collation===undefined?null:String(k.Collation),subPart:k.Sub_part===null||k.Sub_part===undefined?null:Number(k.Sub_part),type:String(k.Index_type||''),nullable:String(k.Null||''),expressionHash:k.Expression===null||k.Expression===undefined?null:hash(String(k.Expression))})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:a.seq-b.seq);
  const pk=indexes.filter(k=>k.name==='PRIMARY').map(k=>k.column);
  // Canonical DDL evidence: the whole SHOW CREATE TABLE text (columns, charset/collation, CHECK, FOREIGN KEY, table options) as one sha256.
  const create=query(ref,'SHOW CREATE TABLE `'+name+'`');const ddl=create[0]&&create[0]['Create Table'];if(typeof ddl!=='string')throw Error('Dolt DDL unknown');
  const h=query(ref,"SELECT DOLT_HASHOF_TABLE('"+name+"') AS h")[0]?.h;const n=query(ref,'SELECT COUNT(*) AS c FROM `'+name+'`')[0]?.c;
  if(!h||n===undefined||n===null)throw Error('Dolt table evidence unknown');
  return {name,kind,columns,pk,indexes,rows:Number(n),ddlHash:hash(ddl),hash:String(h)};
 }).sort((a,b)=>a.name<b.name?-1:1);
 // Branch-exact system objects are read separately; SHOW FULL TABLES omits these system tables on Dolt 2.6.1.
 // Branch-exact object inventory from Dolt's own per-ref system tables (SHOW ... STATUS lists across branches, SHOW CREATE refuses on refs lacking the object).
 // Real Dolt 2.6.1 columns (confirmed on a fictive fixture by the producer): dolt_schemas(type,name,fragment,extra JSON,sql_mode), dolt_procedures(name,create_stmt,created_at,modified_at,sql_mode).
 // EVERY column of EVERY row is hashed (sql_mode, full extra canonicalised with sorted keys, timestamps included): nothing is normalised away or presumed exclusive.
 // These system tables are NOT listed by SHOW FULL TABLES, so their content is hashed directly here. Any other column set is refused.
 const SYS={dolt_schemas:{cols:['type','name','fragment','extra','sql_mode'],order:['type','name']},dolt_procedures:{cols:['name','create_stmt','created_at','modified_at','sql_mode'],order:['name']}};
 const canon=v=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
 const sysObjects=(ref,table)=>{
  const spec=SYS[table];const rows=query(ref,'SELECT * FROM '+table);   // Dolt 2.6.1 returns {} for empty system tables; every error refuses.
  const out=rows.map(r=>{
   if(JSON.stringify(Object.keys(r).sort())!==JSON.stringify([...spec.cols].sort()))throw Error('Dolt system table columns unknown');
   const o={};for(const c of spec.cols){let v=r[c];
    if(v!==null&&typeof v!=='string'&&typeof v!=='number'&&typeof v!=='boolean'&&!(c==='extra'&&typeof v==='object'))throw Error('Dolt system table value unknown');
    if(c==='extra'&&typeof v==='string'){try{v=canon(JSON.parse(v));}catch{v={rawText:v};}}else if(c==='extra'&&v&&typeof v==='object')v=canon(v);
    o[c]=v;}
   if(!ident.test(String(o.name)))throw Error('Dolt object identifier unsafe');return o;});
  out.sort((a,b)=>JSON.stringify(spec.order.map(k=>a[k]))<JSON.stringify(spec.order.map(k=>b[k]))?-1:1);return out;
 };
 const schemaObjects=ref=>({schemas:hash(JSON.stringify(sysObjects(ref,'dolt_schemas'))),procedures:hash(JSON.stringify(sysObjects(ref,'dolt_procedures')))});
 // Dolt's own working-set accounting against HEAD (new/modified/dropped tables, staged or not): the root diff the evidence must account for.
 const workingStatus=ref=>query(ref,'SELECT table_name, staged, status FROM dolt_status ORDER BY table_name, status').map(r=>{if(!ident.test(String(r.table_name)))throw Error('Dolt status identifier unsafe');return {table:String(r.table_name),staged:r.staged===true||r.staged===1||r.staged==='1'||r.staged==='true',status:String(r.status).toLowerCase()};});
 const inventory=()=>{const d=query('','SHOW DATABASES').map(r=>Object.values(r)[0]).filter(n=>!['information_schema','mysql','dolt_cluster'].includes(n)).sort();
  return d.flatMap(db=>query(db,'SELECT name, hash FROM dolt_branches ORDER BY name').map(b=>({db,name:String(b.name),head:String(b.hash),root:String(query(db+'/'+b.name,"SELECT DOLT_HASHOF_DB('WORKING') AS root")[0]?.root||'')})));};
 const first=inventory();if(first.some(x=>!x.root||!x.head))throw Error('Dolt inventory incomplete');
 const entries=first.map(b=>{
  const ref=b.db+'/'+b.name;
  // The session must really be on this database/branch: the evidence is bound to the session identity, not to the requested name.
  if(String(query(ref,'SELECT DATABASE() AS d')[0]?.d)!==ref)throw Error('Dolt session identity mismatch');
  const tables=tableEvidence(ref),objects=schemaObjects(ref),status=workingStatus(ref);
  return {evidence:'dolt-tables-v3',database:b.db,branch:b.name,head:b.head,root:b.root,tables,schemaObjects:objects,status};
 });
 // Final fresh global pass: the same databases, branches, heads and working roots, or the evidence is one incoherent observation.
 if(JSON.stringify(inventory())!==JSON.stringify(first))throw Error('Dolt inventory moved during capture');
 return entries;
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
  // This authenticated tenant-scoped endpoint intentionally projects only seq and commit.
  // Full activation row preservation is checked independently against PostgreSQL.
  const rows=await json(local+'/api/tenants/'+encodeURIComponent(p.tenant)+'/activations',{headers:{authorization:'Bearer '+issued.id_token}},true);
  diagnosticStage='smoke-activations-validation';
  if(!Array.isArray(rows))throw Error('journal unknown');let seq=0;
  for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='commit,seq'||!Number.isSafeInteger(row.seq)||row.seq<=seq||typeof row.commit!=='string'||!row.commit)throw Error('journal schema invalid');seq=row.seq;}
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
 if(mode==='dolt-only'){
  diagnosticStage='capture-dolt';
  if(typeof p.running!=='boolean')throw Error('explicit Dolt read mode required');
  const d=dolt();if(!d.length)throw Error('Dolt coverage empty');
  console.log(JSON.stringify({format:1,kind:'dolt-only-tables-v3',running:p.running,dolt:d}));
 }
 else if(mode==='capture'){diagnosticStage='capture-dolt';const d=dolt();diagnosticStage='capture-bao';const b=await bao();console.log(JSON.stringify({dolt:d,bao:b}));}
 else if(mode==='held-state-check'||mode==='epoch-pre-smoke-check'){
  const log=readFileSync('/data/api.log','utf8');const captured=/automation hold: (\{[^\n]+\})/.exec(log);
  if(process.env.IAM_AUTOMATION_HOLD!=='1'||!captured||JSON.parse(captured[1]).held!==true)throw Error('captured hold required');
  const hashes=await workflowHashes();if(!Object.keys(hashes).length)throw Error('workflow coverage empty');
  if(mode==='epoch-pre-smoke-check'){
   const ledger=JSON.parse(readFileSync('/data/migrations/journal.json','utf8'));
   const manifest=JSON.parse(readFileSync('/app/migration-source/data/migrations/manifest.json','utf8'));
   if(ledger.format!==1||ledger.pending||!Array.isArray(ledger.entries)||!ledger.entries.length||!Array.isArray(manifest.versions)||manifest.versions.length!==ledger.entries.length||manifest.versions.some((v,i)=>v.id!==ledger.entries[i].id||v.checksum!==ledger.entries[i].checksum))throw Error('pre-smoke migration ledger mismatch');
  }
  console.log(JSON.stringify({held:true,hashes}));
 }
 else if(mode==='smoke')console.log(JSON.stringify(await smoke()));
 else throw Error('invalid mode');
}catch(error){const known=['Dolt table listing shape unknown','Dolt system table columns unknown','Dolt system table value unknown','Dolt inventory moved during capture','Dolt session identity mismatch','Dolt view DDL unknown','Dolt table kind unknown','Dolt DDL unknown','Dolt inventory unknown'];const reason=known.indexOf(error?.message);console.error('QUALIFICATION_REASON_V1:'+reason);console.error('QUALIFICATION_DIAG_V1:'+diagnosticStage);console.error('Qualification UNKNOWN or failed. Preserve private evidence and keep maintenance armed.');process.exitCode=1;}
