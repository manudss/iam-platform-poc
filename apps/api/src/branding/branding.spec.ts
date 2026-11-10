import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../plugins/v1/plugins-v1.module.js';
import { BrandingService } from './branding.service.js';
import { BrandingController } from './branding.controller.js';
import { sanitizeSvg } from './svg.js';
import { renderLogo } from './logo.js';
import { DEFAULT_COLORS } from './theme-engine.js';
const manifest = JSON.parse(readFileSync('../../plugins/branding-base/manifest.json','utf8'));
function setup() {
  let settings: Record<string,unknown> = {};
  const reg: any = { resolve: () => ({manifest}), settingsFor: async () => settings };
  return { service: new BrandingService(reg), set: (v: Record<string,unknown>) => {settings=v;} };
}
describe('branding cache and validation', () => {
  it('reuses the computed bundle on repeated pages and after unrelated configuration changes', async () => {
    const {service,set} = setup(); const first = await service.get('demo');
    assert.equal(await service.get('demo'),first);
    set({primaryColor:'#00695c'}); const changed = await service.get('demo');
    assert.notEqual(changed.version,first.version); assert.notEqual(changed.css,first.css);
    set({}); assert.equal(await service.get('demo'),first);
  });
  it('versions the generated css bytes, not only the settings', async () => {
    // Regression: a theme-engine change with unchanged settings must change the version, so clients
    // revalidating a cached theme.css get 200 with the new bytes instead of 304 keeping the old ones.
    const {createHash} = await import('node:crypto');
    const b = await setup().service.get('demo');
    assert.equal(b.version, createHash('sha256').update(JSON.stringify(b.config) + '|' + b.css).digest('hex').slice(0,24));
  });
  it('preview never modifies stored settings and Apply can reuse identical compiled output', async () => {
    const {service,set} = setup(); const before = await service.get('demo');
    const draft = await service.preview('demo',{productName:'Acme'},'draft');
    assert.equal(await service.get('demo'),before); set({productName:'Acme'});
    assert.equal(await service.get('demo'),draft);
  });
  it('rejects invalid seeds, text injection, oversized SVG and unknown settings', async () => {
    for (const input of [{primaryColor:'red'},{accentColor:'#fff'},{productName:'<script>'},{logoMode:'custom'},{unexpected:'x'},{logoSvg:'x'.repeat(50001)}]) await assert.rejects(setup().service.preview('demo',input,'draft'));
  });
  it('rejects active SVG even when it was stored through a generic settings route', async () => {
    const {service,set} = setup();set({logoSvg:'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'});
    await assert.rejects(service.get('demo'));
  });
});
describe('branding public boundary', () => {
  it('a branch name without its exact ticket never reveals unpublished branding', async () => {
    let calls = 0;
    const c = new BrandingController({get: async()=>{calls++;return {};}} as any,{check:async(ticket:string,b:string)=>ticket==='exact'&&b==='draft'} as any);
    const res:any={setHeader(){}};
    await assert.rejects(c.profile('demo','draft','wrong',res));assert.equal(calls,0);
    await assert.rejects(c.profile('demo','main','exact',res));assert.equal(calls,0);
  });
  it('public responses expose only branding; branch tests and preview are no-store', async () => {
    const {service}=setup();const c=new BrandingController(service,{check:async()=>true} as any);
    const headers:Record<string,string>={};const res:any={setHeader(k:string,v:string){headers[k]=v;}};
    const p=await c.profile('demo','','',res);assert.deepEqual(Object.keys(p).sort(),['baseline','footer','productName','version']);
    assert.equal(headers['Cache-Control'],'public, max-age=0, must-revalidate');
    await c.profile('demo','draft','exact',res);assert.equal(headers['Cache-Control'],'no-store');
  });
  it('theme.css revalidation returns 304 only for the current version and fresh bytes otherwise', async () => {
    const {service}=setup(); const c=new BrandingController(service,{check:async()=>true} as any);
    const b=await service.get('demo');
    const make=()=>{const r:any={headers:{},statusCode:200,body:undefined,setHeader(k:string,v:string){r.headers[k]=v;},type(){return r;},send(x:any){r.body=x;},status(s:number){r.statusCode=s;return r;},end(){r.ended=true;}};return r;};
    const stale=make(); await c.css('demo','','',{headers:{'if-none-match':'"outdated-version"'}} as any,stale);
    assert.equal(stale.statusCode,200); assert.equal(stale.body,b.css); assert.equal(stale.headers['ETag'],`"${b.version}"`);
    const fresh=make(); await c.css('demo','','',{headers:{'if-none-match':`"${b.version}"`}} as any,fresh);
    assert.equal(fresh.statusCode,304); assert.equal(fresh.body,undefined);
  });
});
describe('branding SVG security',()=>{
  it('retains inert paths and local gradients',()=>{
    const svg=renderLogo(DEFAULT_COLORS,'light');assert.equal(sanitizeSvg(svg),svg);
    assert.ok(svg.includes('linearGradient'));assert.ok(!svg.includes('{{'));
  });
  it('refuses scripts, foreignObject, CSS, events, external references and XML declarations',()=>{
    for(const body of ['<script/>','<foreignObject/>','<style/>','<path onload="alert(1)"/>','<image href="https://evil.invalid/x"/>','<path fill="url(https://evil.invalid/x)"/>','<animate/>'])assert.throws(()=>sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`));
    assert.throws(()=>sanitizeSvg('<!DOCTYPE svg><svg/>'));
  });
});
