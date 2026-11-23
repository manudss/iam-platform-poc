import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
const source=readFileSync(new URL('./qualification-container.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const tenant='fixture',origin='https://example.test';
async function run({rows=[{seq:1,commit:'abc'}],expected=[{seq:1,commit:'abc'}],status=200,session=200,checksum='a'.repeat(64)}={}){
 const input={tenant,origins:[origin],issuer:origin+'/core',auth:{username:'fictional',password:'fixture-only'},expectedActivationRows:expected,expectedActivationChecksum:checksum,reviewedLegacyRollback:true};let redirect,state,challenge,codeVerifier,calls=[];const output=[],errors=[];
 const fakeProcess={argv:['node','smoke'],stdin:(async function*(){yield JSON.stringify(input);})(),exitCode:0};
 const fetcher=async(url,options={})=>{
  calls.push(url);const u=new URL(url);const respond=(body,code=200,headers={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status:code,headers:{'content-type':'application/json',...headers}});
  if(u.pathname==='/healthz')return respond({});
  if(u.pathname==='/core/authorize'){
   if(u.searchParams.get('redirect_uri')==='https://example.invalid/callback')return respond('unknown client');
   redirect=u.searchParams.get('redirect_uri');state=u.searchParams.get('state');challenge=u.searchParams.get('code_challenge');return respond('<input name="username"><input name="state" value="fixture">',200,{'set-cookie':'s=fixture'});
  }
  if(u.pathname==='/core/authorize/login')return respond('',302,{location:redirect+'?state='+state+'&code=one-use'});
  if(u.pathname==='/core/token'){codeVerifier=JSON.parse(options.body).code_verifier;return respond({id_token:'fixture.'+Buffer.from(JSON.stringify({iss:origin+'/core',aud:'demo-web'})).toString('base64url')+'.signature'});}
  if(u.pathname==='/core/session/extend')return respond({},session);
  if(u.pathname==='/api/tenants/fixture/activations')return respond(rows,status);
  throw Error('Unexpected route');
 };
 // Capture only this execution's console without mutating global console (source-local binding).
 const local=new AsyncFunction('execFileSync','readFileSync','cpSync','mkdtempSync','existsSync','createHash','randomBytes','process','fetch','console',source);
 await local(()=>{throw Error('not expected');},()=>{throw Error('not expected');},()=>{},()=>'',()=>false,createHash,randomBytes,fakeProcess,fetcher,{log:x=>output.push(x),error:x=>errors.push(x)});
 if(!fakeProcess.exitCode)assert.equal(createHash('sha256').update(codeVerifier).digest('base64url'),challenge);
 return{code:fakeProcess.exitCode,output,errors,calls};
}
test('current reduced authenticated route is cross-checked exactly against independent journal',async()=>{const r=await run();assert.equal(r.code,0);assert.equal(JSON.parse(r.output[0]).journal.count,1);assert.ok(!r.calls.some(u=>u.includes('/activations/journal')));});
test('older full route remains accepted with valid tenant/state',async()=>{assert.equal((await run({rows:[{tenant,seq:1,commit:'abc',state:'applied'}]})).code,0);});
for(const [name,args]of Object.entries({missingExpected:{expected:null},missingChecksum:{checksum:null},missingRow:{rows:[]},wrongCommit:{rows:[{seq:1,commit:'wrong'}]},wrongSeq:{rows:[{seq:2,commit:'abc'}]},duplicate:{rows:[{seq:1,commit:'abc'},{seq:1,commit:'abc'}]},wrongTenant:{rows:[{tenant:'other',seq:1,commit:'abc',state:'applied'}]},wrongState:{rows:[{tenant,seq:1,commit:'abc',state:'bad'}]},refused:{status:403},sessionRefused:{session:403}}))test(name+' is UNKNOWN and emits no success archive',async()=>{const r=await run(args);assert.equal(r.code,1);assert.deepEqual(r.output,[]);assert.equal(r.errors.length,2);assert.match(r.errors[0],/^LYAM_QUALIFICATION_DIAGNOSTIC /);});
test('empty journal succeeds only when both independent and authenticated lists are empty',async()=>assert.equal((await run({rows:[],expected:[]})).code,0));

test('diagnostic stage identifies auth/session/journal refusal without credential text',async()=>{
 for(const [args,stage]of [[{session:403},'SESSION_VERIFY'],[{status:403},'ACTIVATION_HTTP'],[{rows:[]},'ACTIVATION_MATCH']]){
  const r=await run(args);const code=JSON.parse(r.errors[0].slice('LYAM_QUALIFICATION_DIAGNOSTIC '.length));assert.equal(code.stage,stage);assert.ok(!JSON.stringify(r.errors).includes('fixture-only'));assert.ok(!JSON.stringify(r.errors).includes('signature'));
 }
});
