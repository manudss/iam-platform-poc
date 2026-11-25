// Read-only live Dolt inventory. Executed inside the held app by the operator.
// No environment, row content, connector values or credentials leave this process.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
const allowed=new Set(['workflow_definitions','workflow_runs','workflow_steps','workflow_tasks','workflow_piece_state','workflow_ticket_links']);
const sqlCodes=new Set(['ER_BAD_DB_ERROR','ER_BAD_TABLE_ERROR','ER_NO_SUCH_TABLE','ER_PARSE_ERROR','ER_ACCESS_DENIED_ERROR','ECONNREFUSED','PROTOCOL_CONNECTION_LOST','ER_UNKNOWN_SYSTEM_VARIABLE','ER_SP_DOES_NOT_EXIST']);
export function diagnostic(error){
 return {format:1,stage:stages.has(error?.captureStage)?error.captureStage:'unknown',category:sqlCodes.has(error?.code)?error.code:(error?.captureCategory==='moving-roots-or-refs'?'moving-roots-or-refs':'refused-or-unknown')};
}
const stages=new Set(['connect','databases','branches','change-session','verify-session','working-root','tables','rows','coherence','coverage','held-setting','close','unknown']);
export async function capture(c){
 let stage='databases';
 try{
 const query=async(sql,args=[])=>{const [r]=await c.query(sql,args);if(!Array.isArray(r))throw Error('row array required');return r;};
 const inventory=async()=>{
  stage='databases';
  const dbs=(await query('SHOW DATABASES')).map(r=>String(Object.values(r)[0])).filter(n=>!['information_schema','mysql','dolt_cluster'].includes(n)).sort();
  if(!dbs.includes('iam')||!dbs.includes('iam_meta'))throw Error('both business databases required');
  const refs=[];
  for(const db of dbs){if(!/^[A-Za-z0-9_]{1,64}$/.test(db))throw Error('database identifier refused');
   stage='branches';
   for(const b of await query('SELECT name, hash FROM `'+db+'`.dolt_branches ORDER BY name')){
    if(typeof b.name!=='string'||!b.name||b.name.length>200||/[`\x00-\x1f]/.test(b.name))throw Error('branch identifier refused');
    const ref=db+'/'+b.name;
    stage='change-session';await c.query('USE `'+ref+'`');
    stage='verify-session';
    if((await query('SELECT DATABASE() AS d'))[0]?.d!==ref)throw Error('session branch differs');
    stage='working-root';const root=(await query("SELECT DOLT_HASHOF_DB('WORKING') AS root"))[0]?.root;
    if(typeof root!=='string'||!root||typeof b.hash!=='string'||!b.hash)throw Error('branch identity unknown');
    refs.push({database:db,branch:b.name,head:b.hash,root});
   }
  }return refs;
 };
 const before=await inventory(),entries=[];
 for(const b of before){
  const ref='`'+b.database+'/'+b.branch+'`';
  stage='tables';const tables=(await query('SHOW TABLES FROM '+ref)).map(r=>String(Object.values(r)[0])).sort();
  const excluded_tables=tables.filter(n=>!allowed.has(n));
  const evidence=[];
  for(const table of tables.filter(n=>allowed.has(n))){
   // Hash every row, not only pending rows: configuration, cursors and inboxes are bound too.
   stage='rows';const rows=await query('SELECT * FROM '+ref+'.`'+table+'` LIMIT 100001');
   if(rows.length>=100000)throw Error('inventory row bound exceeded');
   const hashes=rows.map(digest).sort();
   evidence.push({table,rows:rows.length,sha256:digest(hashes)});
  }
  entries.push({...b,tables:evidence,excluded_tables});
 }
 const after=await inventory();stage='coherence';
 if(JSON.stringify(before)!==JSON.stringify(after))throw Object.assign(Error('Dolt changed during capture'),{captureCategory:'moving-roots-or-refs'});
 stage='coverage';
 if(!entries.some(e=>e.database==='iam_meta'&&e.branch==='main'&&e.tables.some(t=>t.table==='workflow_runs')))throw Error('main runtime coverage absent');
 return {format:1,kind:'live-release-backlog',captured_at:Date.now()/1000,inventory_complete:true,external_coverage:'unverified',entries,sha256:digest(entries),limitations:['Read-only branch/table inventory, no claim about uncollected upstream events','Coherence relies on unchanged Dolt branch roots across capture','No effects, no startup, no resume authorization']};
 }catch(error){error.captureStage=stage;throw error;}
}
export async function main(){
 let c,stage='held-setting';
 try{
  if(process.env.IAM_AUTOMATION_HOLD!=='1')throw Error('held runtime required');
  stage='connect';const require=createRequire('/app/api/package.json'),{createConnection}=require('mysql2/promise');
  c=await createConnection({host:'127.0.0.1',port:3307,user:'root',database:'iam_meta',dateStrings:true});
  console.log(JSON.stringify(await capture(c)));
 }catch(error){console.error('RELEASE_BACKLOG_DIAG_V1 '+JSON.stringify(diagnostic(error.captureStage?error:Object.assign(error,{captureStage:stage}))));process.exitCode=1;}
 finally{if(c)try{await c.end();}catch{console.error('RELEASE_BACKLOG_DIAG_V1 '+JSON.stringify({format:1,stage:'close',category:'refused-or-unknown'}));process.exitCode=1;}}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
