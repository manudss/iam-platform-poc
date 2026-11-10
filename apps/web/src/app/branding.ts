import { afterNextRender, Component, DOCUMENT, Injectable, PendingTasks, TransferState, inject, makeStateKey, signal, input } from '@angular/core';
import { apiUrl } from './api';
export interface BrandProfile { productName: string; baseline: string; footer: string; version: string }
const DEFAULT: BrandProfile = {productName:'lyam',baseline:'IAM next generation',footer:'Fictional demo data only. Do not enter real data.',version:''};
const KEY = makeStateKey<BrandProfile>('iam-branding');
const BASE = '/api/tenants/acme-demo/branding';
/** Branding is public on main, loaded once per page and reused across SPA navigation. Color science runs only
 * on the server; the browser consumes the compiled stylesheet. Branch-test lookups carry their exact ticket. */
@Injectable({providedIn:'root'})
export class Branding {
  readonly profile = signal<BrandProfile>(DEFAULT);
  readonly logoOverride = signal<Record<string,string>>({});
  private doc = inject(DOCUMENT);
  private state = inject(TransferState);
  private pending = inject(PendingTasks);
  private query = '';
  constructor() {
    // Do not mutate the hydrated DOM from a root-service constructor. Styles and
    // profile load after the first render, with an independent SSR handoff.
    if(typeof window==='undefined') { void this.pending.run(()=>this.load()); return; }
    afterNextRender(()=>{
      const q=new URLSearchParams(location.search),branch=q.get('branch'),ticket=q.get('ticket');
      if(branch && branch!=='main' && /^[a-z0-9-]{1,32}$/.test(branch) && ticket)this.query='?'+new URLSearchParams({branch,ticket});
      if(q.get('preview')==='1' && window.parent!==window)return;
      if(this.state.hasKey(KEY)&&!this.query){this.profile.set(this.state.get(KEY,DEFAULT));this.state.remove(KEY);this.stylesheet();}
      else void this.load();
    });
  }
  private stylesheet() {
    let el=this.doc.getElementById('iam-branding-css') as HTMLLinkElement|null;
    if(!el){el=this.doc.createElement('link');el.id='iam-branding-css';el.rel='stylesheet';this.doc.head.appendChild(el);}
    el.href=BASE+'/theme.css'+this.query;
    const icon=this.doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');if(icon)icon.href=BASE+'/favicon.svg'+this.query;
    this.doc.title=this.profile().productName;
  }
  async load() {
    try { const r=await fetch(apiUrl(BASE+this.query),{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('branding');const p=await r.json();if(typeof p.productName==='string'&&typeof p.baseline==='string'&&typeof p.footer==='string')this.profile.set(p); }
    catch {/* Static brand remains readable if branding is temporarily unavailable. */}
    if(typeof window==='undefined')this.state.set(KEY,this.profile());
    else this.stylesheet();
  }
  logo(mode:'light'|'dark') {return this.logoOverride()[`logo-horizontal-${mode}.svg`] || BASE+`/logo-horizontal-${mode}.svg`+this.query;}
  /** The admin keeps its own light/dark choice while the iframe can use another mode. */
  applyBundle(b: any): boolean {
    return this.preview({type:'iam-branding-preview',dark:false,...b},false);
  }
  clearDraft() {
    this.doc.getElementById('iam-branding-preview')?.remove();this.logoOverride.set({});
    void this.load();
  }
  preview(m: unknown, changeMode = true): boolean {
    const x=m as any;
    if(x?.type!=='iam-branding-preview'||typeof x.dark!=='boolean'||!x.theme||!x.config)return false;
    const vars:Record<string,string>={};
    for(const mode of ['light','dark']) {
      if(!x.theme[mode]||typeof x.theme[mode]!=='object')return false;
      const list=Object.entries(x.theme[mode]);if(list.length>150)return false;
      const parts=[];for(const [k,v]of list){if(!/^--[a-z][a-z0-9-]*$/.test(k)||typeof v!=='string'||!/^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(v))return false;parts.push(`${k}:${v}`);}
      vars[mode]=parts.join(';');
    }
    if(['productName','baseline','footer'].some(k=>typeof x.config[k]!=='string'||x.config[k].length>400))return false;
    let style=this.doc.getElementById('iam-branding-preview');if(!style){style=this.doc.createElement('style');style.id='iam-branding-preview';this.doc.body.appendChild(style);}
    style.textContent=`:root{${vars['light']}}:root[data-theme='dark']{${vars['dark']}}`;
    this.profile.set({...DEFAULT,...x.config});
    const logos:Record<string,string>={};for(const mode of ['light','dark']){const k=`logo-horizontal-${mode}.svg`;const svg=x.logos?.[k];if(typeof svg==='string'&&svg.length<=60000)logos[k]='data:image/svg+xml,'+encodeURIComponent(svg);}
    this.logoOverride.set(logos);if(changeMode)this.doc.documentElement.dataset['theme']=x.dark?'dark':'light';
    return true;
  }
}
@Component({selector:'app-brand',template:`<picture class="brandlogo"><img class="for-light" [src]="brand.logo(forceDark()?'dark':'light')" [alt]="brand.profile().productName"><img class="for-dark" [src]="brand.logo('dark')" alt="" aria-hidden="true"></picture><span>{{brand.profile().productName === 'lyam' ? '' : brand.profile().productName}}</span><small>{{brand.profile().baseline}}</small>`,styles:[`:host{display:grid;gap:.2rem}.brandlogo{display:grid}.brandlogo img{height:2.6rem;max-width:100%;width:auto}small{font-size:.9rem;color:var(--brand-sub);font-weight:400}:host-context(.side) small{color:var(--sidebar-muted)}`]})
export class Brand {readonly brand=inject(Branding);readonly forceDark=input(false);}
