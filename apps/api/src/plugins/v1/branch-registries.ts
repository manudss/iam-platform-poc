import { Injectable } from '@nestjs/common';
import { VersioningService } from '../../versioning/versioning.service.js';
import { UsersService } from '../../users/users.service.js';
import { PluginRegistry } from './registry.js';
import { DoltPluginStore } from './dolt-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager, riskGeo } from './builtin/index.js';
/** Separate registries per branch. Authentication always asks for main, never request's working branch. */
@Injectable()
export class BranchRegistries {
  private registries = new Map<string, Promise<PluginRegistry>>();
  constructor(private readonly v: VersioningService, private readonly users: UsersService) {}
  drop(ref: string) { this.registries.delete(ref); }
  get(ref: string) {
    let r=this.registries.get(ref);
    if(!r){r=this.create(ref);this.registries.set(ref,r);r.catch(()=>this.registries.delete(ref));}return r;
  }
  private async create(ref: string) {
    const ds=new DoltPluginStore(this.v,ref);
    const base={...authPassword,handlers:{'auth.authenticate':async(p:any)=>(await this.users.authenticate(p.tenant,p.subject,p.credential.password))?{outcome:'allow',subject:p.subject,methods:['pwd']}:{outcome:'deny',reason:'bad-credentials'}}};
    const r=new PluginRegistry(ds,ds,e=>console.log('[plugins]',JSON.stringify({...e,branch:ref})),ds);
    for(const p of [base,notifyLog,authPasswordLockout(new Map(),base),orgManager,riskGeo])r.register(p);
    await r.load();return r;
  }
}
