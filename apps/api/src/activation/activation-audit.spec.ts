import 'reflect-metadata';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ActivationService, withActivationActor } from './activation.service.js';
import { ActivationReadService } from './activation-read.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { DoltService } from '../dolt/dolt.service.js';

const secrets = { get: async () => undefined } as unknown as SecretsService;
const dolt = { head: async () => 'aaaaaaaa', snapshotAt: async () => ({}), tagActivation: async () => undefined } as unknown as DoltService;
const originalFetch = globalThis.fetch;
const env = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; for (const k of ['IAM_PG_URL','IAM_CORE_URL','IAM_CORE_ADMIN_TOKEN']) { if(env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });

describe('activation attribution and read-only live status', () => {
  it('records server time, isolates concurrent actor contexts, preserves original actor on retry and leaves unknown actors unknown', async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_URL;
    const s = new ActivationService(secrets, dolt);
    const [a,b] = await Promise.all(['alice','bob'].map(id => withActivationActor({ kind:'user', id }, () => s.activate(id,'aaaaaaaa','request-0001'))));
    assert.equal(a.actor?.id, 'alice'); assert.equal(b.actor?.id, 'bob');
    assert.ok(Number.isFinite(Date.parse(a.recordedAt!))); assert.equal(a.appliedAt, undefined);
    const again = await withActivationActor({kind:'user',id:'mallory'}, () => s.activate('alice','aaaaaaaa','request-0001'));
    assert.equal(again.actor?.id, 'alice'); assert.equal(again.recordedAt, a.recordedAt);
    const unknown = await s.activate('t','bbbbbbbb'); assert.equal(unknown.actor, undefined);
  });
  it('stamps confirmation only on successful core apply', async () => {
    delete process.env.IAM_PG_URL; process.env.IAM_CORE_URL='http://core.invalid'; process.env.IAM_CORE_ADMIN_TOKEN='fixture';
    globalThis.fetch = async () => new Response('{}',{status:200});
    const s = new ActivationService(secrets,dolt);
    const a = await s.activate('t','aaaaaaaa'); assert.equal(a.state,'applied'); assert.ok(a.appliedAt);
    globalThis.fetch = async () => new Response('',{status:503});
    const b = await s.activate('t','bbbbbbbb'); assert.equal(b.state,'failed'); assert.equal(b.appliedAt,undefined);
  });
  it('uses the real core version, not the latest journal entry, without POST or reconciliation', async () => {
    process.env.IAM_CORE_URL='http://core.invalid'; process.env.IAM_CORE_ADMIN_TOKEN='fixture';
    let calls=0;
    globalThis.fetch=async (_url,options) => { calls++; assert.notEqual(options?.method,'POST'); return Response.json({seq:5,commit:'bbbbbbbb'}); };
    const r = await new ActivationReadService(new ActivationService(secrets,dolt),dolt).status('tenant name');
    assert.equal(r.status,'confirmed'); assert.deepEqual(r.core,{seq:5,commit:'bbbbbbbb'}); assert.equal(r.matchesMain,false); assert.equal(calls,1);
  });
  it('distinguishes unconfigured, no active version, unavailable and malformed responses', async () => {
    delete process.env.IAM_CORE_URL;
    const s = new ActivationReadService(new ActivationService(secrets,dolt),dolt);
    assert.equal((await s.status('t')).status,'disabled');
    process.env.IAM_CORE_URL='http://core.invalid'; process.env.IAM_CORE_ADMIN_TOKEN='fixture';
    for (const [response,expected] of [[new Response('',{status:404}),'none'],[new Response('',{status:503}),'unavailable'],[Response.json({seq:-1,commit:'junk'}),'unavailable']] as const) {
      globalThis.fetch=async()=>response; assert.equal((await s.status('t')).status,expected);
    }
    globalThis.fetch=async()=>{throw new Error('offline')}; assert.equal((await s.status('t')).status,'unavailable');
  });
});
