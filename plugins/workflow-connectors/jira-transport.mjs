/** Native Jira uses global fetch. Scope restrictions to its async call tree only.
 * No credentials are read, copied or returned by this guard. */
import{AsyncLocalStorage}from'node:async_hooks';
const KEY=Symbol.for('lyam.native-jira-fetch-guard.v1');
if(!globalThis[KEY]){
 const scope=new AsyncLocalStorage(),original=globalThis.fetch;
 const guarded=async(input,init)=>{
  const root=scope.getStore();if(!root)return original(input,init);
  const u=new URL(typeof input==='string'||input instanceof URL?String(input):input.url);
  if(u.origin!==root.origin||!u.pathname.startsWith(root.pathname)||u.username||u.password||u.hash)throw Error('Native Jira transport destination refused');
  // Manual redirects are rejected here, not returned as successful native output.
  const response=await original(input,{...init,redirect:'manual'});
  if(response.status>=300&&response.status<400){await response.body?.cancel();throw Error('Native Jira redirect refused; provider reconciliation may be required');}
  return response;
 };
 globalThis.fetch=guarded;globalThis[KEY]={scope,guarded};
}
export async function withJiraTransport(settings,fn){const state=globalThis[KEY];if(globalThis.fetch!==state.guarded)throw Error('Native Jira transport guard changed');const root=new URL(settings.jiraInstanceUrl.replace(/\/$/,'')+'/rest/api/3/');return state.scope.run(root,fn);}
