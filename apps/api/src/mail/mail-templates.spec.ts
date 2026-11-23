import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MailTemplatesService, MemoryMailTemplateStore } from './mail-templates.js';
import { loadPlugins } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from '../plugins/v1/memory-stores.js';
import { branchContext } from '../workspace/context.js';
import { fakeBusBridge } from '../testing/fake-bus.js';

// Mail template management: the catalogue merged with the branch customization, validation, preview, send-test.
describe('mail templates management', () => {
  let reg: PluginRegistry, svc: MailTemplatesService;
  before(async () => {
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {}, new MemoryStateStore());
    for (const p of loadPlugins()) reg.register(p);
    await reg.load();
    reg.setBus(fakeBusBridge(reg));
    svc = new MailTemplatesService(new MemoryMailTemplateStore(), reg);
  });

  it('lists the catalogue with the defaults effective and nothing customized', async () => {
    const list = await svc.list('t1');
    assert.equal(list[0].key, '_layout');
    const code = list.find((x) => x.key === 'sign-in-code')!;
    assert.equal(code.customized, false);
    assert.match(code.effective.subject!, /Your sign-in code/);
  });

  it('saves, applies and restores a customization; unknown variables are refused', async () => {
    await assert.rejects(() => svc.put('t1', 'admin', 'sign-in-code', { subject: 'Hi {{nope}}', text: 'x' }), /unknown variable/);
    await assert.rejects(() => svc.put('t1', 'admin', 'sign-in-code', { subject: '', text: 'x' }), /subject is required/);
    await assert.rejects(() => svc.put('t1', 'admin', 'unknown-key', { subject: 'a', text: 'b' }), /unknown mail template/);
    const d = await svc.put('t1', 'admin', 'sign-in-code', { subject: 'Code {{code}}', text: 'use {{code}} within {{ttlMinutes}} min', html: '<p>{{code}}</p>' });
    assert.equal(d.customized, true);
    assert.equal(d.override?.subject, 'Code {{code}}');
    const preview = await svc.preview('t1', { key: 'sign-in-code', data: { code: '111', ttlMinutes: 5, subjectUser: 'u' } });
    assert.equal(preview.subject, 'Code 111');
    const restored = await svc.restore('t1', 'admin', 'sign-in-code');
    assert.equal(restored.customized, false);
  });

  it('the layout keeps {{body}} and carries its variables', async () => {
    await assert.rejects(() => svc.put('t1', 'admin', '_layout', { html: '<p>no placeholder</p>' }), /\{\{body\}\}/);
    await svc.put('t1', 'admin', '_layout', { html: '<main>{{body}}</main><footer>{{footer}}</footer>', vars: { footer: 'ACME' } });
    const preview = await svc.preview('t1', { key: 'role.changed', data: { subject: 'u1', role: 'admin', change: 'granted', activation: 7 } });
    assert.match(preview.html!, /^<main>/);
    assert.match(preview.html!, /<footer>ACME<\/footer>/);
    await svc.restore('t1', 'admin', '_layout');
  });

  it('send-test renders and emits through the slot', async () => {
    const r = await svc.sendTest('t1', 'admin', 'workflow.notify', { to: 'admin@example.org' });
    assert.equal(r.sent, true);
    assert.equal(r.real, false); // notify-log is simulated
    assert.equal(r.to, 'admin@example.org');
    await assert.rejects(() => svc.sendTest('t1', 'admin', 'workflow.notify', { to: 'nope' }), /recipient/);
  });
});

describe('user-created versioned templates', () => {
  let svc:MailTemplatesService;
  before(async()=>{
    const reg=new PluginRegistry(new MemoryMigrationStore(),new MemorySettingsStore(),()=>{},new MemoryStateStore());
    for(const p of loadPlugins())reg.register(p);await reg.load();reg.setBus(fakeBusBridge(reg));
    svc=new MailTemplatesService(new MemoryMailTemplateStore(),reg);
  });
  const template=()=>({key:'custom.welcome',name:'Welcome',description:'Fixture',variables:[{name:'person',type:'text',required:true}],subject:'Welcome {{person}}',text:'Hello {{person}}',html:'<p>Hello {{person}}</p>'});
  it('creates, lists, edits, renders and deletes a user-owned template without changing plugin defaults',async()=>{
    const d=await svc.create('owned','admin',template());
    assert.equal(d.owned,true);assert.match(d.revision,/^[a-f0-9]{64}$/);
    assert.ok((await svc.list('owned')).some(t=>t.key==='custom.welcome'));
    assert.equal((await svc.renderWorkflow('owned',d.key,d.revision,{person:'A < B'})).subject,'Welcome A < B');
    assert.match((await svc.renderWorkflow('owned',d.key,d.revision,{person:'A < B'})).html!,/A &lt; B/);
    const changed=await svc.put('owned','admin',d.key,{subject:'Hi {{person}}',text:'Hi {{person}}'});
    assert.notEqual(changed.revision,d.revision);
    await assert.rejects(()=>svc.renderWorkflow('owned',d.key,d.revision,{person:'A'}),/changed/);
    await assert.rejects(()=>svc.renderWorkflow('owned',d.key,changed.revision,{}),/required/);
    await assert.rejects(()=>svc.renderWorkflow('owned',d.key,changed.revision,{person:'A',extra:'B'}),/unknown/);
    await svc.restore('owned','admin',d.key).catch(e=>{assert.match(e.message,/unknown/);});
    await assert.rejects(()=>svc.detail('owned',d.key),/unknown/);
  });
  it('refuses reserved keys, duplicate variables, unknown placeholders and active HTML',async()=>{
    for(const b of [{...template(),key:'sign-in-code'}, {...template(),variables:[{name:'person',type:'text'},{name:'person',type:'text'}]}, {...template(),text:'{{unknown}}'}, {...template(),html:'<script>x</script>'}])
      await assert.rejects(()=>svc.create('invalid','admin',b));
  });
  it('never previews a supplied secret value and refuses secret send-test or subject interpolation',async()=>{
    const b={key:'custom.secret',name:'Secret fixture',variables:[{name:'password',type:'temporary-password',required:true},{name:'expiry',type:'text',required:true}],subject:'Your access',text:'{{password}} until {{expiry}}'};
    const d=await svc.create('secret','admin',b);
    await assert.rejects(()=>svc.create('secret','admin',{...b,key:'custom.invalid-secret',variables:[{name:'password',type:'temporary-password',required:true}]}),/expiry/);
    const preview=await svc.preview('secret',{key:d.key,data:{password:'DO-NOT-LEAK',expiry:'sample'}});
    assert.ok(!JSON.stringify(preview).includes('DO-NOT-LEAK'));assert.match(preview.text,/secret parameter/);
    await assert.rejects(()=>svc.validateWorkflowConfig('secret',{templateKey:d.key,templateRevision:d.revision,param_password:'DO-NOT-STORE',param_expiry:'derived'}),/upstream/);
    await svc.validateWorkflowConfig('secret',{templateKey:d.key,templateRevision:d.revision,param_password:'{{steps.gen.passwordRef}}',param_expiry:'derived'});
    await assert.rejects(()=>svc.put('secret','admin',d.key,{...b,html:'<a href="{{password}}">secret</a>'}),/plain text/);
    await assert.rejects(()=>svc.sendTest('secret','admin',d.key,{to:'demo@example.invalid'}),/cannot use send-test/);
    await assert.rejects(()=>svc.put('secret','admin',d.key,{...b,subject:'{{password}}'}),/subject/);
  });
});


describe('owned template branch and tenant isolation',()=>{
 it('keeps branch drafts isolated by tenant and branch',async()=>{
  const old=process.env.IAM_WORKSPACE_MODE;process.env.IAM_WORKSPACE_MODE='1';
  try {const store=new MemoryMailTemplateStore();const value:any={subject:'Hello',text:'Hi {{person}}',definition:{name:'Fixture',description:'',variables:[{name:'person',type:'text',required:true}]}};
   await branchContext.run({branch:'personal/alice'},()=>store.put('tenant-a','admin','custom.fixture',value));
   assert.equal(await branchContext.run({branch:'main'},()=>store.get('tenant-a','custom.fixture')),undefined);
   assert.equal(await branchContext.run({branch:'personal/alice'},()=>store.get('tenant-b','custom.fixture')),undefined);
   assert.deepEqual(await branchContext.run({branch:'personal/alice'},()=>store.get('tenant-a','custom.fixture')),value);
  }finally{if(old===undefined)delete process.env.IAM_WORKSPACE_MODE;else process.env.IAM_WORKSPACE_MODE=old;}
 });
});
