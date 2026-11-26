// Disposable fixture only. No production endpoint or configurable destination.
import {randomBytes,createHash} from 'node:crypto';
const origin='http://localhost:18088',base='http://127.0.0.1:8080';
const id='test-lyam-qualification',temporary='Synth-Temporary!1234',permanent='Synth-Final!5678';
function fields(html){const out={};for(const m of html.matchAll(/<input\b[^>]*>/gi)){const n=m[0].match(/\bname="([^"]+)"/i)?.[1],v=m[0].match(/\bvalue="([^"]*)"/i)?.[1]??'';if(n)out[n]=v.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");}return out;}
async function login(username,password,next){
 const verifier=randomBytes(32).toString('base64url'),state=randomBytes(16).toString('hex');
 const q=new URLSearchParams({client_id:'demo-web',redirect_uri:origin+'/callback',response_type:'code',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',chain:'password-only'});
 let p=await fetch(base+'/core/authorize?'+q,{redirect:'manual'}),html=await p.text(),cookies=p.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 let r=await fetch(base+'/core/authorize/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie:cookies},body:new URLSearchParams({...fields(html),username,password})});
 if(next){
  if(r.status!==200)throw Error('first access challenge absent');html=await r.text();
  if(!html.includes('newpw')||!html.includes('confirm'))throw Error('first access fields absent');
  const action=html.match(/<form[^>]*action="([^"]+)"/)?.[1];if(!action?.startsWith('/'))throw Error('fixed first access route absent');
  r=await fetch(base+(action.startsWith('/core/')?action:'/core'+action),{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',cookie:cookies},body:new URLSearchParams({...fields(html),a_newpw:next,a_confirm:next})});
 }
 if(r.status!==302)throw Error('OIDC refused');const location=new URL(r.headers.get('location'));
 if(location.origin!==origin||location.pathname!=='/callback'||location.searchParams.get('state')!==state)throw Error('OIDC destination differs');
 const t=await fetch(base+'/core/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:location.searchParams.get('code'),code_verifier:verifier,redirect_uri:origin+'/callback',client_id:'demo-web'})});const token=(await t.json()).id_token;if(!token)throw Error('OIDC token absent');return token;
}
let createDiagnostic;
try {
const admin=await login('demo-alice','demo-only-not-a-secret');
const create=await fetch(base+'/api/tenants/acme-demo/users',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+admin},body:JSON.stringify({id,display_name:'Synthetic qualification only',login_enabled:true,password:temporary,hours:1})});
if(!create.ok){const text=await create.text();createDiagnostic={kind:'synthetic-account-create-diagnostic',status:create.status,unknown_field:/unknown user field/i.test(text),password_policy:/password|character|uppercase|forbidden/i.test(text),invalid_id:/id:|user id/i.test(text),missing_hours:/hours/i.test(text),validation:/invalid/i.test(text),working_branch_required:/working data branch|working branch|branch before/i.test(text)};throw Error('synthetic account create refused '+create.status);}
await login(id,temporary,permanent);const token=await login(id,permanent);
const smoke=await fetch(base+'/api/tenants/acme-demo/activations',{headers:{authorization:'Bearer '+token}});if(!smoke.ok||!Array.isArray(await smoke.json()))throw Error('synthetic no-role smoke refused');
console.log(JSON.stringify({kind:'synthetic-dedicated-qualification-account',created:true,first_access_changed:true,new_password_oidc:true,no_role_smoke:true,production_data_used:false,cleanup:'entire disposable data/container removed by parent fixture'}));

} catch (error) { const detail=String(error.message); console.log(JSON.stringify({kind:'synthetic-dedicated-qualification-account',passed:false,createDiagnostic,error:detail.startsWith('synthetic ')||detail.startsWith('first access ')||detail.startsWith('fixed first ')||detail.startsWith('OIDC ')?detail:'unclassified synthetic auth failure'}));process.exitCode=1;}
