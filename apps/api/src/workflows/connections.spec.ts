import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowConnections, validateConnection, classifyProbeError } from './connections.js';
import {mock} from 'node:test';
import { branchContext } from '../workspace/context.js';
process.env.IAM_WORKFLOW_REAL_CONNECTIONS = '1';   // real connections are off by default on a server; these specs exercise them with fictional values

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
    for (const instanceUrl of ['https://api.atlassian.com/ex/jira/not-a-uuid', 'https://api.atlassian.com/other', 'https://api.atlassian.com/', 'https://evil.invalid', 'http://team.atlassian.net', 'https://user:pass@team.atlassian.net', 'https://team.atlassian.net/path', 'https://team.atlassian.net?x=1']) assert.throws(() => validateConnection({...jira, config: {...jira.config, instanceUrl}}));
    assert.throws(() => validateConnection({...jira, provider:'google-sheets', config:{}, secret:'{"type":"service_account","token_uri":"https://evil.invalid"}'}));
  });
  it('accepts the gateway URL of one Jira site (tokens with scopes) and keeps it as given', () => {
    const gw = 'https://api.atlassian.com/ex/jira/9963bb3b-629b-4729-b37a-c71e6fc94882';
    const v = validateConnection({...jira, config: {...jira.config, instanceUrl: gw}}) as any;
    assert.equal(v.config.instanceUrl.replace(/\/$/, ''), gw);
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

  it('a stored credential never follows a changed destination or account: saving or testing needs the credential typed again',async()=>{
    const h=setup(); const calls:any[]=[]; const stub=mock.method(h.service as any,'httpProbe',async(url:string,o:any)=>{calls.push({url,auth:!!o.headers?.Authorization});return {status:200};});
    try {
      const http=await h.service.save('t',undefined,{name:'x',provider:'http',config:{baseUrl:'https://good.example.com/'},secret:'FICTIONAL'});
      await assert.rejects(()=>h.service.testDraft('t',{name:'x',provider:'http',config:{baseUrl:'https://other.example.net/'},existingId:http.connection.id}),/entered again/);
      await assert.rejects(()=>h.service.save('t',http.connection.id,{name:'x',provider:'http',config:{baseUrl:'https://third.example.org/'}}),/entered again/);
      assert.equal(calls.length,0);
      await h.service.save('t',http.connection.id,{name:'renamed',provider:'http',config:{baseUrl:'https://good.example.com/'}});
      const j=await h.service.save('t',undefined,{...jira,secret:'FICTIONAL'});
      await assert.rejects(()=>h.service.save('t',j.connection.id,{...jira,config:{...jira.config,instanceUrl:'https://other.atlassian.net'}}),/entered again/);
      await assert.rejects(()=>h.service.save('t',j.connection.id,{...jira,config:{...jira.config,email:'someone@example.invalid'}}),/entered again/);
      await h.service.save('t',j.connection.id,{...jira,config:{...jira.config,instanceUrl:'https://other.atlassian.net'},secret:'NEW-FICTIONAL'});
    } finally {stub.mock.restore();}
  });
  it('the credential is sealed to its destination outside Dolt: a row edited directly (merge, SQL, other endpoint) never receives it, Sheets targets included',async()=>{
    const h=setup();
    const j=await h.service.save('t',undefined,{...jira,secret:'FICTIONAL'});
    assert.equal((await h.service.resolve('t','main',j.connection.id,'jira')).secret,'FICTIONAL');
    const row=[...h.rows.values()].find((c:any)=>c.id===j.connection.id);
    for(const edit of [{instanceUrl:'https://other.atlassian.net/'},{email:'someone@example.invalid'},{siteUrl:'https://other.atlassian.net/'}]){
      const saved={...row.config}; row.config={...saved,...edit};
      await assert.rejects(()=>h.service.resolve('t','main',j.connection.id,'jira'),/not bound/); row.config=saved;
    }
    assert.equal((await h.service.resolve('t','main',j.connection.id,'jira')).secret,'FICTIONAL');
    const key=JSON.stringify({type:'service_account',client_email:'bot@proj.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',token_uri:'https://oauth2.googleapis.com/token'});
    const g=await h.service.save('t',undefined,{name:'Sheets',provider:'google-sheets',config:{spreadsheetId:'sheet-aaaaaaaaaa',sheetId:'0'},secret:key});
    const grow=[...h.rows.values()].find((c:any)=>c.id===g.connection.id);
    await assert.rejects(()=>h.service.save('t',g.connection.id,{name:'Sheets',provider:'google-sheets',config:{spreadsheetId:'sheet-bbbbbbbbbb',sheetId:'0'}}),/entered again/);
    await assert.rejects(()=>h.service.save('t',g.connection.id,{name:'Sheets',provider:'google-sheets',config:{spreadsheetId:'sheet-aaaaaaaaaa',sheetId:'5'}}),/entered again/);
    grow.config={...grow.config,spreadsheetId:'sheet-bbbbbbbbbb'};
    await assert.rejects(()=>h.service.resolve('t','main',g.connection.id,'google-sheets'),/not bound/);
    // a record without the seal (older revision) is refused, never trusted
    for(const [k,v] of h.secrets) h.secrets.set(k,{value:v.value});
    grow.config={...grow.config,spreadsheetId:'sheet-aaaaaaaaaa'};
    await assert.rejects(()=>h.service.resolve('t','main',g.connection.id,'google-sheets'),/not bound/);
  });
  it('real connections are disabled by default: saving a secret, testing and resolving are refused before any store write or external call',async()=>{
    const h=setup(); const prev=process.env.IAM_WORKFLOW_REAL_CONNECTIONS; const calls:any[]=[];
    const stub=mock.method(h.service as any,'httpProbe',async(u:string)=>{calls.push(u);return {status:200};});
    const j=await h.service.save('t',undefined,{...jira,secret:'FICTIONAL'});
    try {
      for(const v of [undefined,'0','true','']) {
        if(v===undefined) delete process.env.IAM_WORKFLOW_REAL_CONNECTIONS; else process.env.IAM_WORKFLOW_REAL_CONNECTIONS=v;
        await assert.rejects(()=>h.service.save('t',undefined,{...jira,secret:'FICTIONAL-2'}),/disabled/);
        await assert.rejects(()=>h.service.testDraft('t',{...jira,secret:'FICTIONAL'}),/disabled/);
        await assert.rejects(()=>h.service.test('t',j.connection.id),/disabled/);
        await assert.rejects(()=>h.service.resolve('t','main',j.connection.id,'jira'),/disabled/);
      }
      assert.equal(calls.length,0); assert.equal(h.secrets.size,1);
    } finally {stub.mock.restore(); process.env.IAM_WORKFLOW_REAL_CONNECTIONS=prev;}
  });
});

describe('a connection of the same id on a run branch never receives the credential of main', () => {
  const seed = async () => {
    const h = setup(); const saved = await h.service.save('t', undefined, {...jira, secret:'FICTIONAL-MAIN-TOKEN'});
    const id = saved.connection.id; const main = h.rows.get(`t:main:${id}`) ?? [...h.rows.values()][0];
    return {h, id, main};
  };
  const homonym = (h: any, id: string, main: any, patch: any) => { const {ref: _r, ...base} = main; h.rows.set(`t:run-x:${id}`, {...base, ...patch, ref: 'run-x'}); };
  it('main still resolves with its own credential', async () => {
    const {h, id} = await seed();
    const key = [...h.rows.keys()][0]; const row = h.rows.get(key); if (!key.includes(':main:')) { h.rows.delete(key); h.rows.set(`t:main:${id}`, row); }
    assert.equal((await h.service.resolve('t', 'main', id, 'jira')).secret, 'FICTIONAL-MAIN-TOKEN');
  });
  it('a homonym on the run branch with another destination and the same secret reference is refused (credential sealed to its destination)', async () => {
    const {h, id, main} = await seed();
    const key = [...h.rows.keys()][0]; const row = h.rows.get(key); h.rows.delete(key); h.rows.set(`t:main:${id}`, row);
    homonym(h, id, row, {config: {...row.config, instanceUrl: 'https://evil.atlassian.net'}});
    await assert.rejects(() => h.service.resolve('t', 'run-x', id, 'jira'), /not bound/);
    assert.equal((await h.service.resolve('t', 'main', id, 'jira')).secret, 'FICTIONAL-MAIN-TOKEN');
  });
  it('a homonym with no secret reference gets no credential and does not fall back to main', async () => {
    const {h, id} = await seed();
    const key = [...h.rows.keys()][0]; const row = h.rows.get(key); h.rows.delete(key); h.rows.set(`t:main:${id}`, row);
    homonym(h, id, row, {secretRef: undefined});
    await assert.rejects(() => h.service.resolve('t', 'run-x', id, 'jira'), /secret not configured/);
  });
  it('a homonym pointing at the secret of another connection id is refused', async () => {
    const {h, id} = await seed();
    const key = [...h.rows.keys()][0]; const row = h.rows.get(key); h.rows.delete(key); h.rows.set(`t:main:${id}`, row);
    homonym(h, id, row, {secretRef: row.secretRef.replace(`/${id}/`, '/other-conn/')});
    await assert.rejects(() => h.service.resolve('t', 'run-x', id, 'jira'), /invalid scoped secret reference/);
  });
});

describe('read-only check failure classes', () => {
  it('maps errors to a closed class from status, code and fixed keywords only', () => {
    const e = (o: any) => Object.assign(new Error(o.message ?? 'x'), o);
    assert.equal(classifyProbeError(e({ status: 401 })), 'credential-rejected');
    assert.equal(classifyProbeError(e({ message: 'invalid_grant: Invalid grant: account not found' })), 'credential-rejected');
    assert.equal(classifyProbeError(e({ response: { status: 403 }, message: 'Google Sheets API has not been used in project 123 before or it is disabled' })), 'api-disabled');
    assert.equal(classifyProbeError(e({ response: { status: 403 }, message: 'The caller does not have permission' })), 'forbidden');
    assert.equal(classifyProbeError(e({ response: { status: 403 }, message: 'User is disabled' })), 'forbidden');
    // a service status wins over a parse error and over ambiguous keywords
    assert.equal(classifyProbeError(Object.assign(new SyntaxError('Unexpected token'), { status: 500 })), 'upstream-status');
    assert.equal(classifyProbeError(Object.assign(new Error('private key rejected'), { response: { status: 404 } })), 'not-found');
    assert.equal(classifyProbeError(e({ response: { status: 404 } })), 'not-found');
    assert.equal(classifyProbeError(e({ code: 'ENOTFOUND' })), 'network');
    assert.equal(classifyProbeError(e({ message: 'external request timed out' })), 'network');
    assert.equal(classifyProbeError(new SyntaxError('Unexpected token')), 'credential-format');
    assert.equal(classifyProbeError(e({ status: 500 })), 'upstream-status');
    assert.equal(classifyProbeError(e({ message: 'missing spreadsheet' })), 'configuration');
    assert.equal(classifyProbeError('boom'), 'unknown');
  });
  it('a failed Jira check returns the class and a fixed message, never the upstream text or the credential', async () => {
    const h = setup();
    const stub = mock.method(h.service as any, 'httpProbe', async () => ({ status: 401, body: { message: 'UPSTREAM-DETAIL-SHOULD-NOT-LEAK' } }));
    try {
      const r: any = await h.service.testDraft('t', { ...jira, secret: 'FICTIONAL-SECRET-VALUE' });
      assert.equal(r.status, 'Failed'); assert.equal(r.reason, 'credential-rejected');
      const text = JSON.stringify(r);
      assert.ok(!text.includes('FICTIONAL-SECRET-VALUE') && !text.includes('UPSTREAM-DETAIL') && !text.includes('test@example.invalid'));
    } finally { stub.mock.restore(); }
  });
  it('an unreachable service is classified as network', async () => {
    const h = setup();
    const stub = mock.method(h.service as any, 'httpProbe', async () => { throw new Error('external request failed'); });
    try { assert.equal(((await h.service.testDraft('t', { ...jira, secret: 'FICTIONAL' })) as any).reason, 'network'); } finally { stub.mock.restore(); }
  });
});

describe('failed checks leak nothing sensitive', () => {
  const SENSITIVE = ['FICTIONAL-TOKEN-xyz', 'fictional-header-secret', 'iam/workflow-connections/t/secret-ref', 'service-account-key-material'];
  const noLeak = (text: string) => { for (const v of SENSITIVE) assert.ok(!text.includes(v), `leaked ${v}`); };
  it('a Jira (HTTP probe) failure carrying sensitive text in message, headers and secret path returns only the class, and nothing reaches console or logger', async () => {
    const h = setup();
    const lines: string[] = [];
    const spies = ['log', 'error', 'warn', 'info', 'debug'].map(k => mock.method(console as any, k, (...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    const out = mock.method(process.stdout, 'write', (c: unknown) => { lines.push(String(c)); return true; });
    const err = mock.method(process.stderr, 'write', (c: unknown) => { lines.push(String(c)); return true; });
    const nock = Object.assign(new Error(`Request failed ${SENSITIVE.join(' ')}`), { response: { status: 403, headers: { authorization: SENSITIVE[1] }, data: { secretRef: SENSITIVE[2] } }, config: { headers: { Authorization: SENSITIVE[0] } } });
    const httpStub = mock.method(h.service as any, 'httpProbe', async () => { throw nock; });
    try {
      const r: any = await h.service.testDraft('t', { ...jira, secret: SENSITIVE[0] });
      noLeak(JSON.stringify(r));
      assert.equal(r.reason, 'forbidden');
    } finally { httpStub.mock.restore(); spies.forEach(s => s.mock.restore()); out.mock.restore(); err.mock.restore(); }
    noLeak(lines.join('\n'));
  });
  it('a saved connection whose stored credential cannot be read reports secret-store without the reference', async () => {
    const h = setup();
    const saved = await h.service.save('t', undefined, { ...jira, secret: 'FICTIONAL' });
    h.secrets.clear();
    const r: any = await h.service.testDraft('t', { ...jira, existingId: saved.connection.id });
    assert.equal(r.status, 'Failed'); assert.equal(r.reason, 'secret-store');
    noLeak(JSON.stringify(r)); assert.ok(!JSON.stringify(r).includes('iam/workflow-connections'));
  });
});


describe('explicit full-catalogue Google scope',()=>{
 it('requires resubmitted secret when broadening a connection and preserves legacy seals',async()=>{
  const h=setup();const secret=JSON.stringify({type:'service_account',client_email:'fixture@fictional.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',token_uri:'https://oauth2.googleapis.com/token'});
  const saved=await h.service.save('t',undefined,{name:'Google',provider:'google-sheets',config:{spreadsheetId:'fictional',sheetId:'0'},secret});
  assert.equal((await h.service.resolve('t','main',saved.connection.id,'google-sheets')).settings.googleScope,'spreadsheet');
  await assert.rejects(()=>h.service.save('t',saved.connection.id,{name:'Google',provider:'google-sheets',config:{spreadsheetId:'fictional',sheetId:'0',googleScope:'account'}}),/credential entered again/);
  await h.service.save('t',saved.connection.id,{name:'Google',provider:'google-sheets',config:{spreadsheetId:'fictional',sheetId:'0',googleScope:'account'},secret});assert.equal((await h.service.resolve('t','main',saved.connection.id,'google-sheets')).settings.googleScope,'account');
 });
});
