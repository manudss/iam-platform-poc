#!/usr/bin/env node
// Read only. Never exports response bodies, headers, keys, env or deploy hooks.
import {pathToFileURL} from 'node:url';
export async function inspectProduction({key=process.env.RENDER_API_KEY,fetcher=fetch}={}) {
 if(!key)throw Error('Render access unavailable');
 async function read(path){
  const r=await fetcher('https://api.render.com/v1'+path,{method:'GET',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'}});
  if(!r.ok)throw Error('Render read refused: HTTP '+r.status);
  return r.json();
 }
 const rows=await read('/services?name=iam-poc&limit=20');
 const matches=rows.map(x=>x.service??x).filter(x=>x.name==='iam-poc');
 if(matches.length!==1)throw Error('UNKNOWN: expected one exact service');
 const s=matches[0],details=s.serviceDetails??{},image=s.image?.imagePath??details.image?.imagePath??null;
 const deployments=await read('/services/'+encodeURIComponent(s.id)+'/deploys?limit=20');
 const active=deployments.map(x=>x.deploy??x).filter(x=>!['live','build_failed','update_failed','canceled','deactivated'].includes(x.status)).map(x=>({status:x.status}));
 // Only these explicit known parameters leave the process. Never stringify the service itself.
 const state={status:'OBSERVED',runtime:details.runtime??s.runtime??null,autoDeploy:s.autoDeploy??details.autoDeploy??null,repo:s.repo??null,branch:s.branch??null,image,activeDeployments:active};
 if(state.repo&&!/^https:\/\/github\.com\/manudss\/[a-zA-Z0-9._-]+(?:\.git)?$/.test(String(state.repo)))state.repo='PRESENT_OTHER_REPOSITORY';
 if(state.branch&&!/^[a-zA-Z0-9._/-]{1,100}$/.test(String(state.branch)))state.branch='PRESENT_OTHER_REF';
 if(state.image){const u=String(state.image);state.image=/^ghcr\.io\/manudss\/iam-platform-poc(?::[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/.test(u)?u:'PRESENT_OTHER_IMAGE';}
 state.risk=state.runtime!=='image'||state.repo!==null||state.branch!==null||state.autoDeploy!=='no'||!/^ghcr\.io\/manudss\/iam-platform-poc@sha256:[a-f0-9]{64}$/.test(state.image??'')||active.length>0;
 return state;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const state=await inspectProduction();console.log(JSON.stringify(state));if(state.risk)process.exitCode=1;}
 catch{console.error('Render read failed or UNKNOWN; no response body exported');process.exitCode=1;}
}
