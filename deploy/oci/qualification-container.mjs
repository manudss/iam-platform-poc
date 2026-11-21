// Executed inside an isolated helper container (capture) or candidate (smoke).
// Private auth and Bao tokens never leave this process or appear in stdout.
import {execFileSync} from 'node:child_process';
import {readFileSync,cpSync,mkdtempSync,existsSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
// Closed-enum failure stages: on failure the process reports ONLY one of these tokens
// (never exception content), so a masked UNKNOWN stays attributable to a zone.
const STAGES=new Set(['INPUT','MODE','DOLT_COPY','DOLT_QUERY','BAO_HEALTH','BAO_WALK','SMOKE_HEALTH','SMOKE_LOGIN','SMOKE_TOKEN','SMOKE_SESSION','SMOKE_JOURNAL','SMOKE_NEGATIVE','SMOKE_LEDGER','OUTPUT']);
let stage='INPUT';const mark=s=>{if(!STAGES.has(s))throw Error('unknown stage token');stage=s;};
let p; // assigned inside the boundary below; module scope because bao/dolt/smoke read it
const json=async(url,options={})=>{
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(15000)});
 if(r.status!==200||!/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''))throw Error('non-200 or non-JSON response');
 return r.json();
};
async function bao(){
 const base=p.baoAddress,token=p.baoToken;
 if(!base||!token||!Array.isArray(p.baoMetadataRoots)||!p.baoMetadataRoots.length)throw Error('Bao metadata coverage/auth missing');
 mark('BAO_HEALTH');
 const status=await json(base+'/v1/sys/health');if(status.sealed!==false)throw Error('Bao sealed/unknown');
 mark('BAO_WALK');
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
 mark('DOLT_COPY');
 const dir=p.running?'/data/dolt':mkdtempSync('/tmp/qualification-')+'/dolt';
 if(!p.running)cpSync('/data/dolt',dir,{recursive:true,errorOnExist:true});
 mark('DOLT_QUERY');
 const query=(db,sql)=>{const r=JSON.parse(execFileSync('dolt',[...(p.running?['--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','']:[]),...(db?['--use-db='+db]:[]),'sql','-r','json','-q',sql],{cwd:dir,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']}));if(!Array.isArray(r.rows))throw Error('Dolt inventory unknown');return r.rows;};
 const dbs=query('','SHOW DATABASES').map(r=>Object.values(r)[0]).filter(n=>!['information_schema','mysql','dolt_cluster'].includes(n)).sort();
 if(!dbs.includes('iam'))throw Error('business database absent');
 return dbs.flatMap(db=>query(db,'SELECT name, hash FROM dolt_branches ORDER BY name').map(b=>{
  const rows=query(db+'/'+b.name,"SELECT DOLT_HASHOF_DB('WORKING') AS root");if(!rows[0]?.root)throw Error('Dolt working root unknown');return {database:db,branch:b.name,head:b.hash,root:rows[0].root};
 }));
}
async function smoke(){
 const local='http://127.0.0.1:8080';
 mark('SMOKE_HEALTH');
 if(!(await fetch(local+'/healthz')).ok)throw Error('edge health failed');
 const credentials=p.auth;
 if(typeof credentials.username!=='string'||typeof credentials.password!=='string')throw Error('auth input missing');
 let journal;
 for(const origin of p.origins){
  mark('SMOKE_LOGIN');
  const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),state=randomBytes(16).toString('hex');
  const params=new URLSearchParams({client_id:'demo-web',redirect_uri:origin+'/callback',response_type:'code',state,code_challenge:challenge,code_challenge_method:'S256',chain:'password-only'});
  const page=await fetch(local+'/core/authorize?'+params,{redirect:'manual'}),html=await page.text();
  if(page.status!==200||!html.includes('name="username"'))throw Error('expected origin/form refused');
  const fields={};for(const m of html.matchAll(/<input\b[^>]*>/gi)){const tag=m[0],name=tag.match(/\bname="([^"]+)"/i)?.[1],value=tag.match(/\bvalue="([^"]*)"/i)?.[1]??'';if(name&&!['username','password'].includes(name))fields[name]=value.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}
  fields.username=credentials.username;fields.password=credentials.password;
  const logged=await fetch(local+'/core/authorize/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie:page.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')},body:new URLSearchParams(fields)});
  if(logged.status!==302)throw Error('real OIDC login failed');
  const location=new URL(logged.headers.get('location')??'');if(location.origin!==origin||location.pathname!=='/callback'||location.searchParams.get('state')!==state||!location.searchParams.get('code'))throw Error('OIDC redirect/state failed');
  mark('SMOKE_TOKEN');
  const issued=await json(local+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:location.searchParams.get('code'),code_verifier:verifier,redirect_uri:origin+'/callback',client_id:'demo-web'})});
  if(typeof issued.id_token!=='string')throw Error('token absent');
  const claims=JSON.parse(Buffer.from(issued.id_token.split('.')[1],'base64url').toString());
  if(claims.iss!==p.issuer||!(claims.aud==='demo-web'||Array.isArray(claims.aud)&&claims.aud.includes('demo-web')))throw Error('issuer/audience mismatch');
  mark('SMOKE_SESSION');
  const session=await fetch(local+'/core/session/extend',{method:'POST',headers:{authorization:'Bearer '+issued.id_token}});if(![200,409].includes(session.status))throw Error('session token verification failed');
  mark('SMOKE_JOURNAL');
  const rows=await json(local+'/api/tenants/'+encodeURIComponent(p.tenant)+'/activations',{headers:{authorization:'Bearer '+issued.id_token}});
  if(!Array.isArray(rows))throw Error('journal unknown');let seq=0;
  for(const row of rows){if(row.tenant!==p.tenant||!Number.isSafeInteger(row.seq)||row.seq<=seq||typeof row.commit!=='string'||!row.commit||!['pending','recorded','applied','failed'].includes(row.state))throw Error('journal schema invalid');seq=row.seq;}
  journal={count:rows.length,checksum:hash(JSON.stringify(rows))};
 }
 mark('SMOKE_NEGATIVE');
 const negative=await fetch(local+'/core/authorize?'+new URLSearchParams({client_id:'demo-web',redirect_uri:'https://example.invalid/callback',response_type:'code',state:'negative',code_challenge:'A'.repeat(43),code_challenge_method:'S256'}));
 if(!/unknown client/i.test(await negative.text()))throw Error('negative redirect check failed');
 mark('SMOKE_LEDGER');
 if(p.reviewedLegacyRollback===true&&!existsSync('/data/migrations/journal.json')&&!existsSync('/app/migration-source/data/migrations/manifest.json'))return {journal,ledger:'legacy-rollback-no-migration-ledger'};
 const ledger=JSON.parse(readFileSync('/data/migrations/journal.json','utf8'));
 if(ledger.format!==1||ledger.pending||!Array.isArray(ledger.entries)||!ledger.entries.length)throw Error('migration ledger incomplete');
 const expected=JSON.parse(readFileSync('/app/migration-source/data/migrations/manifest.json','utf8'));
 if(expected.versions.length!==ledger.entries.length||expected.versions.some((v,i)=>v.id!==ledger.entries[i].id||v.checksum!==ledger.entries[i].checksum))throw Error('migration history mismatch');
 return {journal,ledger:ledger.entries.map(e=>({id:e.id,checksum:e.checksum}))};
}
try{
 // mode selection, stdin read (262144 bound) and JSON parse stay INSIDE the boundary:
 // any failure reports stage=INPUT/MODE only, never a stack or an input snippet.
 const [mode]=process.argv.slice(1);
 let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>262144)throw Error('input bound');}
 p=JSON.parse(raw);
 mark('MODE');
 let result;
 if(mode==='capture')result={dolt:dolt(),bao:await bao()};
 else if(mode==='smoke')result=await smoke();
 else throw Error('invalid mode');
 mark('OUTPUT');
 console.log(JSON.stringify(result));
}catch{console.error('Qualification UNKNOWN or failed (stage='+stage+'). Preserve private evidence and keep maintenance armed.');process.exitCode=1;}
