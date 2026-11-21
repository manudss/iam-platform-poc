import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { RunSecrets } from './run-secrets.js';
// Fakes only: no mail is sent, no data store is touched. The canary is the generated password: it must never appear in an output, a log, a stored intent or an error.
const mailApi = loadPluginModule('workflow-connectors', 'mail-api.mjs') as any;
class Fake { static calls: any[] = []; static mode: 'ok' | 'throw' | 'noid' = 'ok';
  emails = { send: async (payload: any, opts: any) => { Fake.calls.push({ payload, opts }); if (Fake.mode === 'throw') throw new Error('network'); if (Fake.mode === 'noid') return { data: {} }; return { data: { id: 'msg-1' } }; } };
}
const HOUR = 3_600_000;
const HEAD = 'abcdef0123456789';
const MAIN = 'main000111222333';

function world(over: { proof?: any; fa?: any; email?: string | null; blocks?: any[]; readFails?: boolean } = {}) {
  const secrets = new RunSecrets();
  const seen = { logs: [] as string[], pending: [] as any[], reveals: 0, setCalls: [] as any[] };
  const state = {
    proof: { mainCommit: MAIN, activation: 'applied', activationCommit: MAIN, containsHead: true, ...(over.proof ?? {}) },
    fa: over.fa === undefined ? { required: true, expired: false, revision: 'rev-1', expiresAt: Date.now() + 24 * HOUR - 5000 } : over.fa,
    email: over.email === undefined ? 'bao@example.test' : over.email,
    blocks: over.blocks ?? [{ kind: 'suspended' }],
  };
  const mk = (runId: string, type: string) => {
    const use = ({ 'lyam-set-temporary-password': 'set-temporary', 'lyam-send-secret-mail': 'mail' } as any)[type];
    const scoped = {
      generate: () => { if (type !== 'lyam-generate-password') throw new Error('secret reference unavailable'); return secrets.create(runId, ['set-temporary', 'mail']); },
      reveal: (ref: string) => { seen.reveals++; if (!use) throw new Error('secret reference unavailable'); return secrets.reveal(runId, ref, use); },
      drop: (ref: string) => secrets.drop(runId, ref),
    };
    return {
      tenant: 'acme', runId, secrets: scoped, dryRun: false, test: false, outputs: {},
      settings: { mailAllowedRecipients: 'bao@example.test' },
      log: (l: string) => seen.logs.push(l),
      workspace: { proof: async () => { if (over.readFails) throw new Error('db down'); return state.proof; } },
      users: { firstAccess: async () => state.fa, emailOf: async () => state.email },
      accounts: { activeBlocks: async () => state.blocks },
      setTemporaryPassword: async (a: any) => { seen.setCalls.push({ id: a.id, hours: a.hours }); return { revision: 'rev-1', expiresAt: Date.now() + a.hours * HOUR }; },
      markEffectPending: async (i: any) => { seen.pending.push(i); },
    } as any;
  };
  return { secrets, seen, mk };
}
const mailCfg = (ref: string, over: any = {}) => ({ account: 'bao', to: 'bao@example.test', subject: 'Votre acces', text: 'Mot de passe: [[password]] valable jusqu\'au [[expiry]] ([[hours]] h)', passwordRef: ref, hours: '24', revision: 'rev-1', sourceHead: HEAD, ...over });
const withMail = async (fn: () => Promise<void>) => { const old = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'test-key-not-real'; mailApi.mailClient.Ctor = Fake; Fake.calls = []; Fake.mode = 'ok'; try { await fn(); } finally { mailApi.mailClient.Ctor = null; if (old === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = old; } };
const gen = externalBlock('lyam-generate-password')!, setTmp = externalBlock('lyam-set-temporary-password')!, mail = externalBlock('lyam-send-secret-mail')!;
const everything = (w: ReturnType<typeof world>, extra: unknown[] = []) => JSON.stringify([w.seen.logs, w.seen.pending, w.seen.setCalls, extra]);

describe('RunSecrets', () => {
  it('only the same run and an allowed use can resolve a reference; expiry and drop refuse; nothing is listed', () => {
    let t = 1000; const s = new RunSecrets(() => t, 5000);
    const ref = s.create('r1', ['mail'], 'canary-value');
    assert.equal(s.reveal('r1', ref, 'mail'), 'canary-value');
    assert.throws(() => s.reveal('r2', ref, 'mail'), /unavailable/); assert.throws(() => s.reveal('r1', ref, 'set-temporary'), /unavailable/); assert.throws(() => s.reveal('r1', 'secret:nope', 'mail'), /unavailable/);
    assert.deepEqual(s.valuesOf('r1'), ['canary-value']); assert.deepEqual(s.valuesOf('r2'), []);
    t += 6000; assert.throws(() => s.reveal('r1', ref, 'mail'), /unavailable/);
    const r2 = s.create('r1', ['mail']); s.drop('r1', r2); assert.throws(() => s.reveal('r1', r2, 'mail'), /unavailable/);
  });
});

describe('generate and set-temporary blocks', () => {
  it('generate returns only an opaque reference, and no other block type can create one', async () => {
    const w = world(); const out: any = await gen.run(w.mk('run-1', 'lyam-generate-password'));
    assert.match(out.passwordRef, /^secret:[0-9a-f]{24}$/);
    const pw = w.secrets.valuesOf('run-1')[0]; assert.ok(pw.length >= 20);
    assert.ok(!everything(w, [out]).includes(pw));
    assert.throws(() => w.mk('run-1', 'lyam-send-mail').secrets.generate(), /unavailable/);
  });
  it('set-temporary uses the reference and the real hours, outputs no password, and refuses an unknown or foreign reference without writing', async () => {
    const w = world(); const ref = ((await gen.run(w.mk('run-1', 'lyam-generate-password'))) as any).passwordRef; const pw = w.secrets.valuesOf('run-1')[0];
    const out: any = await setTmp.run({ ...w.mk('run-1', 'lyam-set-temporary-password'), config: { subject: 'bao', passwordRef: ref, hours: '24' } });
    assert.equal(out.revision, 'rev-1'); assert.equal(out.hours, 24); assert.deepEqual(w.seen.setCalls, [{ id: 'bao', hours: 24 }]); assert.ok(!everything(w, [out]).includes(pw));
    await assert.rejects(() => setTmp.run({ ...w.mk('run-2', 'lyam-set-temporary-password'), config: { subject: 'bao', passwordRef: ref, hours: '24' } }), /unavailable/);
    await assert.rejects(() => setTmp.run({ ...w.mk('run-1', 'lyam-set-temporary-password'), config: { subject: 'bao', passwordRef: 'secret:zz', hours: '24' } }), /unavailable/);
    assert.equal(w.seen.setCalls.length, 1);
  });
  it('hours are validated (zero, too many, text)', () => { for (const h of ['0', '721', 'abc', '-1']) assert.throws(() => setTmp.validate({ subject: 'bao', passwordRef: 'secret:x', hours: h }), /hours/); });
});

describe('lyam-send-secret-mail guard and effect', () => {
  const prepare = async (w: ReturnType<typeof world>) => { const ref = ((await gen.run(w.mk('run-1', 'lyam-generate-password'))) as any).passwordRef; return { ref, pw: w.secrets.valuesOf('run-1')[0] }; };
  it('sends once after the real-state checks, shows the recorded expiry, keeps the password out of every record, drops the secret', async () => withMail(async () => {
    const w = world(); const { ref, pw } = await prepare(w);
    const out: any = await mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) });
    assert.equal(Fake.calls.length, 1); assert.ok(Fake.calls[0].payload.text.includes(pw)); assert.match(Fake.calls[0].payload.text, /jusqu'au \d{4}-\d\d-\d\d \d\d:\d\d UTC \(24 h\)/);
    assert.match(Fake.calls[0].opts.idempotencyKey, /^wf-secretmail\/run-1\//); assert.equal(out.accepted, true); assert.ok(!everything(w, [out]).includes(pw));
    assert.equal(w.seen.pending.length, 1); assert.equal(w.seen.pending[0].account, 'bao');
    assert.throws(() => w.secrets.reveal('run-1', ref, 'mail'), /unavailable/);
  }));
  const refusals: [string, Parameters<typeof world>[0], any?][] = [
    ['head not contained in main (published by another branch)', { proof: { containsHead: false } }],
    ['activation not applied', { proof: { activation: 'failed' } }],
    ['activation on another commit than main', { proof: { activationCommit: 'other' } }],
    ['no first-access rule', { fa: { required: false } }],
    ['first-access expired', { fa: { required: true, expired: true, revision: 'rev-1', expiresAt: 1 } }],
    ['credential revision is not the one this run set', { fa: { required: true, expired: false, revision: 'rev-OTHER', expiresAt: Date.now() + 24 * HOUR } }],
    ['expiry later than the parameter allows', { fa: { required: true, expired: false, revision: 'rev-1', expiresAt: Date.now() + 100 * HOUR } }],
    ['recipient is not the identity e-mail', { email: 'someone.else@example.test' }],
    ['identity has no e-mail', { email: null }],
    ['account already unblocked', { blocks: [] }],
    ['state cannot be read', { readFails: true }],
  ];
  for (const [name, over] of refusals) it(`refuses and sends nothing: ${name}`, async () => withMail(async () => {
    const w = world(over); const { ref } = await prepare(w); const before = w.seen.reveals;
    await assert.rejects(() => mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) }), /lyam-send-secret-mail/);
    assert.equal(Fake.calls.length, 0); assert.equal(w.seen.pending.length, 0); assert.equal(w.seen.reveals, before, 'the secret is not even resolved');
    assert.ok(w.secrets.valuesOf('run-1').length === 1, 'the secret is kept for a later retry of the whole run');
  }));
  it('fails closed when the real-state readers are missing', async () => withMail(async () => {
    const w = world(); const { ref } = await prepare(w); const c = w.mk('run-1', 'lyam-send-secret-mail'); delete c.workspace;
    await assert.rejects(() => mail.run({ ...c, config: mailCfg(ref) }), /not available/); assert.equal(Fake.calls.length, 0);
  }));
  it('recipient not allowed, no API key: nothing sent', async () => withMail(async () => {
    const w = world(); const { ref } = await prepare(w);
    await assert.rejects(() => mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), settings: {}, config: mailCfg(ref) }), /allowed recipients/);
    delete process.env.RESEND_API_KEY; await assert.rejects(() => mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) }), /RESEND_API_KEY/); assert.equal(Fake.calls.length, 0);
  }));
  it('unknown provider outcome: intent was recorded BEFORE the call, one attempt only, the secret is kept, no password in the error', async () => withMail(async () => {
    for (const mode of ['throw', 'noid'] as const) {
      const w = world(); const { ref, pw } = await prepare(w); Fake.mode = mode; Fake.calls = [];
      await assert.rejects(() => mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) }), (e: Error) => !e.message.includes(pw));
      assert.equal(w.seen.pending.length, 1); assert.equal(Fake.calls.length, mode === 'throw' ? 1 : 1); assert.ok(!everything(w).includes(pw));
      assert.equal(w.secrets.valuesOf('run-1').length, 1);
    }
  }));
  it('two concurrent attempts of the same run, account and revision carry the same provider idempotency key', async () => withMail(async () => {
    const w = world(); const { ref } = await prepare(w);
    await Promise.allSettled([mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) }), mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), config: mailCfg(ref) })]);
    assert.ok(Fake.calls.length >= 1); assert.equal(new Set(Fake.calls.map((c) => c.opts.idempotencyKey)).size, 1);
  }));
  it('a test run only logs; the text must carry the password and expiry placeholders', async () => withMail(async () => {
    const w = world(); const out: any = await mail.run({ ...w.mk('run-1', 'lyam-send-secret-mail'), test: true, config: mailCfg('secret:x') });
    assert.equal(out.accepted, false); assert.equal(Fake.calls.length, 0);
    assert.throws(() => mail.validate({ ...mailCfg('secret:x'), text: 'no placeholder' }), /\[\[password\]\]/);
    assert.throws(() => mail.validate({ ...mailCfg('secret:x'), text: 'only [[password]]' }), /\[\[expiry\]\]/);
  }));
});
