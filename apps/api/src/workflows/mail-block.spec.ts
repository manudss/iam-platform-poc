import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock } from './model.js';
import { validateConnection } from './connections.js';
// Stubs only: no mail is sent. Shows the recipient rule, the idempotent effect key and the refusal of a mail that was not really delivered.
const block = () => externalBlock('lyam-send-mail')!;
const base = (over: any = {}) => ({ tenant: 'acme', config: { to: 'owner@example.test', subject: 'Votre acces', text: 'Bonjour' }, settings: { mailAllowedRecipients: 'owner@example.test' }, dryRun: false, log: () => {}, outputs: {}, runId: 'run-1', ...over });
describe('lyam-send-mail block', () => {
  it('is merged as a real-capable lyam block', () => { assert.ok(block()); assert.equal(block().family, 'lyam'); });
  it('refuses a recipient that is not in the allowed list, and an empty list, before any send', async () => {
    let sent = 0; const mail = { send: async () => { sent++; return { delivered: true, real: true }; } };
    await assert.rejects(() => block().run(base({ mail, config: { to: 'other@example.test', subject: 's', text: 't' } }) as any), /not in the allowed recipients/);
    await assert.rejects(() => block().run(base({ mail, settings: {} }) as any), /not in the allowed recipients/);
    assert.equal(sent, 0);
  });
  it('a test run only logs and sends nothing', async () => {
    let sent = 0; const lines: string[] = [];
    const out = await block().run(base({ test: true, mail: { send: async () => { sent++; return { delivered: true, real: true }; } }, log: (l: string) => lines.push(l) }) as any);
    assert.equal(sent, 0); assert.equal((out as any).delivered, false); assert.ok(lines[0].includes('nothing sent'));
  });
  it('uses the same effect key for the same run, recipient and subject, and fails when the mail was only simulated', async () => {
    const keys: string[] = [];
    const ok = { send: async (_t: string, m: any) => { keys.push(m.effectKey); return { delivered: true, real: true, id: 'id-1' }; } };
    await block().run(base({ mail: ok }) as any); await block().run(base({ mail: ok }) as any);
    assert.equal(keys[0], keys[1]);
    const degraded = { send: async () => ({ delivered: false, real: false, degraded: 'RESEND_API_KEY not set on the server' }) };
    await assert.rejects(() => block().run(base({ mail: degraded }) as any), /not really delivered \(RESEND_API_KEY/);
  });
  it('refuses a header injection in the subject and several addresses', async () => {
    const mail = { send: async () => ({ delivered: true, real: true }) };
    await assert.rejects(() => block().run(base({ mail, config: { to: 'owner@example.test', subject: 'a\nBcc: x@y.test', text: 't' } }) as any), /one line/);
    await assert.rejects(() => block().run(base({ mail, config: { to: 'a@example.test,b@example.test', subject: 's', text: 't' } }) as any), /one e-mail address/);
  });
});
describe('Jira connection site URL', () => {
  const gw = 'https://api.atlassian.com/ex/jira/9963bb3b-629b-4729-b37a-c71e6fc94882';
  const mk = (siteUrl?: string) => ({ name: 'J', provider: 'jira', config: { instanceUrl: gw, email: 'a@example.test', ...(siteUrl ? { siteUrl } : {}) } });
  it('keeps a valid atlassian.net site and refuses anything else', () => {
    assert.equal((validateConnection(mk('https://team.atlassian.net') as any) as any).config.siteUrl, 'https://team.atlassian.net/');
    for (const u of ['https://evil.example', 'http://team.atlassian.net', 'https://team.atlassian.net/x', 'https://u:p@team.atlassian.net']) assert.throws(() => validateConnection(mk(u) as any), u);
  });
});
