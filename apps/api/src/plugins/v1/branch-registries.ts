import { Injectable } from '@nestjs/common';
import { VersioningService } from '../../versioning/versioning.service.js';
import { UsersService } from '../../users/users.service.js';
import { PluginRegistry } from './registry.js';
import { BusHost } from './bus-host.js';
import { DoltPluginStore } from './dolt-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo, hrAttributes, organizations, workflowsIga, appConnector, policyStudio, oidcProvider } from './builtin/index.js';
/** Separate registries per branch. Authentication always asks for main, never request's working branch. */
@Injectable()
export class BranchRegistries {
  private registries = new Map<string, Promise<PluginRegistry>>();
  private mainRegistry?: PluginRegistry;
  /** One bus host per process, created once: recreating it would double-serve plugin.*.call (round-robin, incoherent dedupe). */
  private host?: Promise<BusHost | undefined>;
  private heads=new Map<string,string>();
  constructor(private readonly v: VersioningService, private readonly users: UsersService) {}
  drop(ref: string) { this.registries.delete(ref);this.heads.delete(ref); }
  async get(ref: string) {
    const head=await this.v.at(ref,async c=>{const [r]=await c.query("select hashof('HEAD') h");return String((r as {h:string}[])[0].h);});
    if(this.heads.get(ref)!==head){this.drop(ref);this.heads.set(ref,head);}
    let r=this.registries.get(ref);
    if(!r){r=this.create(ref);this.registries.set(ref,r);r.catch(()=>this.registries.delete(ref));}return r;
  }
  private async create(ref: string) {
    const ds=new DoltPluginStore(this.v,ref);
    const base={...authPassword,handlers:{'auth.authenticate':async(p:any)=>(await this.users.authenticate(p.tenant,p.subject,p.credential.password))?{outcome:'allow',subject:p.subject,methods:['pwd']}:{outcome:'deny',reason:'bad-credentials'}}};
    const r=new PluginRegistry(ds,ds,e=>console.log('[plugins]',JSON.stringify({...e,branch:ref})),ds);
    for(const p of [base,notifyLog,authPasswordLockout(new Map(),base),orgManager,riskGeo,hrAttributes,organizations,workflowsIga,appConnector,policyStudio,oidcProvider])r.register(p);
    await r.load();
    // Step 2: only the applied state (main) is served over the core bus; preview branches keep the in-process path
    // (step 2 boundary, documented in docs/plugin-contract-v2.md).
    if(ref==='main'){
      this.mainRegistry=r;
      this.host??=BusHost.startIfConfigured(async()=>this.mainRegistry!);
      const host=await this.host;if(host)r.setBus(host.bridge());
    }
    return r;
  }
}
