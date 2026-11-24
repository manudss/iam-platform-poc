/** Native Jira uses global fetch. Scope restrictions to its async call tree only. */
import{AsyncLocalStorage}from'node:async_hooks';
import{isJiraBase}from'./jira-api.mjs';
const KEY=Symbol.for('lyam.native-jira-fetch-guard.v2');
const safePath=path=>!/%(?:2f|5c|2e|25)/i.test(path)&&!path.includes('\\')&&!path.includes('//');
export function jiraTransportRoot(settings){const base=settings?.jiraInstanceUrl;if(!isJiraBase(base))throw Error('Native Jira connection destination refused');return new URL(base.replace(/\/$/,'')+'/');}
export function assertJiraDestination(value,root,custom=false){
 const u=new URL(value,root),prefix=root.pathname;
 const roots=custom?['rest/api/3/']:['rest/api/3/','rest/api/2/','rest/agile/1.0/'];
 if(u.origin!==root.origin||u.username||u.password||u.hash||!safePath(u.pathname)||!roots.some(p=>u.pathname.startsWith(prefix+p)))throw Error('Native Jira transport destination refused');
 return u;
}
if(!globalThis[KEY]){
 const scope=new AsyncLocalStorage(),original=globalThis.fetch;
 const guarded=async(input,init)=>{
  const root=scope.getStore();if(!root)return original(input,init);
  assertJiraDestination(typeof input==='string'||input instanceof URL?String(input):input.url,root);
  const response=await original(input,{...init,redirect:'manual'});
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('Native Jira redirect refused; provider reconciliation may be required');}
  return response;
 };
 globalThis.fetch=guarded;globalThis[KEY]={scope,guarded};
}
export async function withJiraTransport(settings,fn){const state=globalThis[KEY];if(globalThis.fetch!==state.guarded)throw Error('Native Jira transport guard changed');return state.scope.run(jiraTransportRoot(settings),fn);}
