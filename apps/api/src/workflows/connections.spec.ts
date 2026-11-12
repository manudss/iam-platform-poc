import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowConnections, validateConnection } from './connections.js';
import {mock} from 'node:test';
import { branchContext } from '../workspace/context.js';

const jira = { name: 'Support Jira', provider: 'jira', config: { instanceUrl: 'https://team.atlassian.net', email: 'test@example.invalid' } };
function setup(enabled = true) {
  const rows = new Map<string, any>(), secrets = new Map<string, any>(); let reads = 0;
  const store: any = { listConnections: async (t: string, ref: string) => [...rows.values()].filter(c => c.tenant === t && c.ref === ref).map(({ref, ...c}) => c), getConnection: async (t: string, id: string, ref: string) => { const c = rows.get(`${t}:${ref}:${id}`); if (!c) return null; const {ref: _, ...data} = c; return data; }, putConnection: async (c: any, ref: string) => rows.set(`${c.tenant}:${ref}:${c.id}`, {...c, ref}), deleteConnection: async (t: string, id: string, ref: string) => rows.delete(`${t}:${ref}:${id}`) };
  const bao: any = { enabled, put: async (path: string, data: any) => { assert.equal(secrets.has(path), false); secrets.set(path, data); }, get: async (p: string) => { reads++; return secrets.get(p); } };
  return { service: new WorkflowConnections(store, bao), rows, secrets, get reads() { return reads; } };
}
describe('managed workflow connections', () => {
  it('rejects arbitrary secret references, unexpected fields and unsafe Jira destinations', () => {
    assert.throws(() => validateConnection({...jira, secretRef: 'other-tenant/token'}), /unknown/);
    for (const instanceUrl of ['https://evil.invalid', 'http://team.atlassian.net', 'https://user:pass@team.atlassian.net', 'https://team.atlassian.net/path', 'https://team.atlassian.net?x=1']) assert.throws(() => validateConnection({...jira, config: {...jira.config, instanceUrl}}));
    assert.throws(() => validateConnection({...jira, provider:'google-sheets', config:{}, secret:'{"type":"service_account","token_uri":"https://evil.invalid"}'}));
  });
  it('never saves credentials to metadata or returns them; immutable revisions preserve older branch configurations', async () => {
    const h = setup(); const saved = await h.service.save('tenant-a', undefined, {...jira, secret:'TEST-NOT-A-REAL-TOKEN'});
    const id = saved.connection.id; assert.equal(JSON.stringify(saved).includes('TEST-NOT'), false);
    const first = [...h.rows.values()][0]; assert.equal(JSON.stringify(first).includes('TEST-NOT'), false); assert.equal(first.secretRef.includes('/tenant-a/'), true);
    await h.service.save('tenant-a', id, {...jira, secret:'SECOND-TEST-TOKEN'});
    assert.equal(h.secrets.size, 2); assert.equal(h.secrets.get(first.secretRef).value, 'TEST-NOT-A-REAL-TOKEN');
    const result = await h.service.resolve('tenant-a', 'main', id, 'jira'); assert.equal(result.settings.jiraApiToken, 'SECOND-TEST-TOKEN');
    await assert.rejects(() => h.service.resolve('tenant-b', 'main', id, 'jira'));
    await assert.rejects(() => h.service.resolve('tenant-a', 'main', id, 'http'));
    const list = await h.service.list('tenant-a'); assert.equal(JSON.stringify(list).includes('secretRef'), false); assert.equal(JSON.stringify(list).includes('SECOND-TEST'), false);
  });
  it('fails closed without OpenBao and does not persist any submitted secret', async () => {
    const h = setup(false); await assert.rejects(() => h.service.save('t', undefined, {...jira, secret:'TEST-TOKEN'}), /OpenBao/); assert.equal(h.rows.size,0); assert.equal(h.secrets.size,0);
  });
  it('rejects a cross-tenant secret reference even if metadata was corrupted', async () => {
    const h=setup(); const r=await h.service.save('t',undefined,jira); const row=[...h.rows.values()][0];row.secretRef='iam/workflow-connections/another/secret'; await assert.rejects(()=>h.service.resolve('t','main',r.connection.id,'jira'),/scoped/);assert.equal(h.reads,0);
  });
  it('tests unsaved input using GET for Jira and HEAD for HTTP without persisting or disclosing secrets', async () => {
    const h=setup(); const transport=h.service as any;
    const calls:any[]=[]; const stub=mock.method(transport,'httpProbe',async(url:string,options:any)=>{calls.push({url,...options});return {status:200};});
    try {
      const result=await h.service.testDraft('t',{...jira,secret:'FICTIONAL-PROBE-TOKEN'});
      assert.equal(result.status,'Verified');assert.equal(JSON.stringify(result).includes('TOKEN'),false);assert.equal(calls[0].method,'GET');assert.ok(calls[0].url.endsWith('/rest/api/3/myself'));
      await h.service.testDraft('t',{name:'API',provider:'http',config:{baseUrl:'https://example.com/api'},secret:'FICTIONAL-PROBE-TOKEN'});
      assert.equal(calls[1].method,'HEAD');assert.equal(h.rows.size,0);assert.equal(h.secrets.size,0);
      stub.mock.mockImplementation(async()=>{throw new Error('FICTIONAL-PROBE-TOKEN');});
      const failed=await h.service.testDraft('t',{...jira,secret:'FICTIONAL-PROBE-TOKEN'});assert.equal(failed.status,'Failed');assert.equal(JSON.stringify(failed).includes('TOKEN'),false);
    } finally {stub.mock.restore();}
  });
  it('draft tests only reuse a same-tenant, same-provider connection secret',async()=>{
    const h=setup();const r=await h.service.save('t',undefined,{...jira,secret:'TOKEN'});
    await assert.rejects(()=>h.service.testDraft('other',{...jira,existingId:r.connection.id}));
    await assert.rejects(()=>h.service.testDraft('t',{name:'HTTP',provider:'http',config:{baseUrl:'https://example.com'},existingId:r.connection.id}));
  });

});
