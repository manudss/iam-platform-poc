import { Injectable, Optional } from '@nestjs/common';
import { ApplicationBus } from '../../events/application-bus.service.js';
import { VersioningService } from '../../versioning/versioning.service.js';
import { UsersService } from '../../users/users.service.js';
import { PluginImpl, PluginRegistry } from './registry.js';
import { BusHost, BusHostRef } from './bus-host.js';
import { DoltPluginStore } from './dolt-stores.js';
import { authPassword, shippedPlugins } from './builtin/index.js';
/** Separate registries per branch. Authentication always asks for main, never request's working branch. */
@Injectable()
export class BranchRegistries {
  private registries = new Map<string, Promise<PluginRegistry>>();
  /** Registries whose build has finished. The bus host reads THIS map (synchronously resolvable), never the
   * pending promises: its first sync runs while main is still being built, and awaiting it would deadlock. */
  private resolved = new Map<string, PluginRegistry>();
  private mainRegistry?: PluginRegistry;
  /** One bus host per process, created once: recreating it would double-serve plugin.*.call (round-robin, incoherent dedupe). */
  private host?: Promise<BusHost | undefined>;
  private heads=new Map<string,string>();
  constructor(private readonly v: VersioningService, private readonly users: UsersService, @Optional() private readonly events?: ApplicationBus, @Optional() private readonly busRef?: BusHostRef) {}
  drop(ref: string) { this.registries.delete(ref);this.resolved.delete(ref);this.heads.delete(ref); }
  async get(ref: string) {
    const head=await this.v.at(ref,async c=>{const [r]=await c.query("select hashof('HEAD') h");return String((r as {h:string}[])[0].h);});
    if(this.heads.get(ref)!==head){this.drop(ref);this.heads.set(ref,head);}
    let r=this.registries.get(ref);
    if(!r){r=this.create(ref);this.registries.set(ref,r);r.catch(()=>this.registries.delete(ref));}return r;
  }
  private async create(ref: string) {
    const ds=new DoltPluginStore(this.v,ref);
    const base={...authPassword,handlers:{...authPassword.handlers,'auth.authenticate':async(p:any)=>(await this.users.authenticate(p.tenant,p.subject,p.credential.password))?{outcome:'allow',subject:p.subject,methods:['pwd']}:{outcome:'deny',reason:'bad-credentials'}}};
    const r=new PluginRegistry(ds,ds,e=>console.log('[plugins]',JSON.stringify({...e,branch:ref})),ds);
    // The one shipped list (P1: catalogue partagé) - same set as the main registry, base override first.
    for(const p of [base,...shippedPlugins().slice(1)])r.register(p);
    await r.load();
    this.resolved.set(ref,r); // resolved BEFORE any host sync: the host reads only finished registries
    // Step 3 (decision 7): every branch shares the one bus. The host resolves each delivery against the registry
    // of the envelope's branch and pushes the union of all loaded branches' registrations. Every branch registry
    // emits through the bus with its branch stamped (main creates the host; branches built later attach below,
    // branches built earlier attach when main creates the host).
    if(ref==='main'){
      this.mainRegistry=r;
      this.host??=BusHost.startIfConfigured(
        async()=>this.mainRegistry!,
        undefined,
        (branch)=>this.get(branch||'main'),
        async()=>[...this.resolved.entries()],
      );
      const host=await this.host;
      // Decision 6: the bus is MANDATORY - no host, no registry (specs use testing/test-bus.ts).
      if(!host)throw new Error('event bus required (step 3, decision 6): set IAM_BUS_NATS_URL, IAM_BUS_NATS_PASSWORD and IAM_CORE_ADMIN_TOKEN, with a reachable nats-server and core');
      for(const [b,reg]of this.resolved)reg.setBus(host.bridge(),b);if(this.events)host.attachEvents(this.events);if(this.busRef)this.busRef.host=host;
    } else {
      const host=await this.host;
      if(host)r.setBus(host.bridge(),ref);
    }
    return r;
  }
  /** Registers an archive-imported plugin into every already-built registry. Branch registries built LATER see it after a restart (they register the shipped list) - the import response says so. Only the duplicate case is skipped; any other registration error aborts the import (P0-7: errors are not absorbed). */
  registerEverywhere(impl: PluginImpl) {
    for (const reg of this.resolved.values()) if (!reg.impl(impl.manifest.id)) reg.register(impl);
  }
}
