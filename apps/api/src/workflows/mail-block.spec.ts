import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { validateConnection } from './connections.js';
// Stubs only: no mail is sent. Shows the recipient rule, the idempotent effect key and the refusal of a mail that was not really delivered.
const block = () => externalBlock('lyam-send-mail')!;
const base = (over: any = {}) => ({ tenant: 'acme', config: { to: 'owner@example.test', subject: 'Votre acces', text: 'Bonjour' }, settings: { mailAllowedRecipients: 'owner@example.test' }, liveMailSettings: async () => over.settings ?? ({ mailAllowedRecipients: 'owner@example.test' }), dryRun: false, log: () => {}, outputs: {}, runId: 'run-1', ...over });
const mailApi = loadPluginModule('workflow-connectors', 'mail-api.mjs') as any;
class Fake { static calls: any[] = []; static mode: 'ok' | 'error' | 'throw' | 'noid' = 'ok';
  constructor(public key: string) {}
  emails = { send: async (payload: any, opts: any) => { Fake.calls.push({ payload, opts, key: this.key }); if (Fake.mode === 'throw') throw new Error('network'); if (Fake.mode === 'error') return { error: { name: 'invalid_from_address' } }; if (Fake.mode === 'noid') return { data: {} }; return { data: { id: 'msg-1' } }; } };
}
describe('lyam-send-mail block', () => {
  const withKey = async (fn: () => Promise<void>) => { const old = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'test-key-not-real'; mailApi.mailClient.Ctor = Fake; Fake.calls = []; Fake.mode = 'ok'; try { await fn(); } finally { mailApi.mailClient.Ctor = null; if (old === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = old; } };
  it('is merged as a real-capable lyam block', () => { assert.ok(block()); assert.equal(block().family, 'lyam'); });
  it('refuses a recipient that is not in the allowed list, and an empty list, before any call', async () => withKey(async () => {
    await assert.rejects(() => block().run(base({ config: { to: 'other@example.test', subject: 's', text: 't' } }) as any), /not in the allowed recipients/);
    await assert.rejects(() => block().run(base({ settings: {} }) as any), /not in the allowed recipients/);
    assert.equal(Fake.calls.length, 0);
  }));
  it('real mail uses current-main policy, never a stale branch allowlist, and refuses an unavailable live reader', async () => withKey(async () => {
    await assert.rejects(()=>block().run(base({liveMailSettings:async()=>({})}) as any), /allowed recipients/);
    await assert.rejects(()=>block().run(base({liveMailSettings:undefined}) as any), /live mail policy is not available/);
    await assert.rejects(()=>block().run(base({liveMailSettings:async()=>{throw Error('fixture read failed');}}) as any), /live mail policy cannot be read/);
    assert.equal(Fake.calls.length,0);
    await block().run(base({settings:{},liveMailSettings:async()=>({mailAllowedRecipients:'owner@example.test'})}) as any);
    assert.equal(Fake.calls.length,1);
  }));
  it('a test run only logs and calls nothing, even with a key', async () => withKey(async () => {
    const lines: string[] = [];
    const out = await block().run(base({ test: true, log: (l: string) => lines.push(l) }) as any);
    assert.equal(Fake.calls.length, 0); assert.equal((out as any).accepted, false); assert.ok(lines[0].includes('nothing sent'));
  }));
  it('without RESEND_API_KEY it fails closed and calls nothing', async () => {
    const old = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY; mailApi.mailClient.Ctor = Fake; Fake.calls = [];
    try { await assert.rejects(() => block().run(base() as any), /RESEND_API_KEY is not set/); assert.equal(Fake.calls.length, 0); }
    finally { mailApi.mailClient.Ctor = null; if (old !== undefined) process.env.RESEND_API_KEY = old; }
  });
  it('sends with a stable provider idempotency key for the same run, recipient and subject, and returns the provider id', async () => withKey(async () => {
    const a = await block().run(base() as any); await block().run(base() as any);
    assert.equal((a as any).messageId, 'msg-1'); assert.equal((a as any).accepted, true);
    assert.equal(Fake.calls[0].opts.idempotencyKey, Fake.calls[1].opts.idempotencyKey);
    assert.match(Fake.calls[0].opts.idempotencyKey, /^wf-mail\/run-1\//);
    assert.equal(Fake.calls[0].payload.from, 'lyam@dss.name');
    await block().run(base({ runId: 'run-2' }) as any);
    assert.notEqual(Fake.calls[2].opts.idempotencyKey, Fake.calls[0].opts.idempotencyKey);
  }));
  it('a provider refusal, an unreachable provider or a missing id fail with no credential in the message', async () => withKey(async () => {
    for (const mode of ['error', 'throw', 'noid'] as const) {
      Fake.mode = mode;
      await assert.rejects(() => block().run(base() as any), (e: Error) => !e.message.includes('test-key-not-real') && /provider/.test(e.message));
    }
  }));
  it('refuses a header injection in the subject and several addresses', async () => withKey(async () => {
    await assert.rejects(() => block().run(base({ config: { to: 'owner@example.test', subject: 'a\nBcc: x@y.test', text: 't' } }) as any), /one line/);
    await assert.rejects(() => block().run(base({ config: { to: 'a@example.test,b@example.test', subject: 's', text: 't' } }) as any), /one e-mail address/);
  }));
});
describe('Jira connection site URL', () => {
  const gw = 'https://api.atlassian.com/ex/jira/9963bb3b-629b-4729-b37a-c71e6fc94882';
  const mk = (siteUrl?: string) => ({ name: 'J', provider: 'jira', config: { instanceUrl: gw, email: 'a@example.test', ...(siteUrl ? { siteUrl } : {}) } });
  it('keeps a valid atlassian.net site and refuses anything else', () => {
    assert.equal((validateConnection(mk('https://team.atlassian.net') as any) as any).config.siteUrl, 'https://team.atlassian.net/');
    for (const u of ['https://evil.example', 'http://team.atlassian.net', 'https://team.atlassian.net/x', 'https://u:p@team.atlassian.net']) assert.throws(() => validateConnection(mk(u) as any), u);
  });
});
