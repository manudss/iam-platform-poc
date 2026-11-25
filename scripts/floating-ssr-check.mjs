// Actual built SSR server and fictional session/API. No network beyond loopback.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const api=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.endsWith('/me/access')?{subject:'fixture',admin:true,restricted:true,plugins:{}}:req.url.endsWith('/launchpad')?{apps:[{id:'fixture',name:'SSR fixture',protocol:'oidc',url:'https://example.invalid'}],preferences:{favourites:['fixture'],order:[]}}:{}));});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const port=4317;let logs='';const child=spawn(process.execPath,['apps/web/dist/web/server/server.mjs'],{env:{...process.env,PORT:String(port),IAM_WEB_API_ORIGIN:`http://127.0.0.1:${api.address().port}`},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
try{
 const token='fixture.'+Buffer.from(JSON.stringify({sub:'fixture',exp:Math.floor(Date.now()/1000)+600})).toString('base64url')+'.fixture';
 let response;for(let i=0;i<60;i++){try{response=await fetch(`http://localhost:${port}/my-applications`,{headers:{cookie:'iam_session='+token},redirect:'manual'});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const text=await response.text();assert.equal(response.status,200,JSON.stringify({status:response.status,text:text.slice(0,250),logs}));assert(text.includes('SSR fixture'),'SSR response includes seeded fictional application');assert(!text.includes('Cannot GET'));
 console.log('Floating assistant actual SSR PASS, authenticated /my-applications renders without browser globals');
}finally{child.kill();await new Promise(r=>child.once('exit',r));api.closeAllConnections();await new Promise(r=>api.close(r));}
