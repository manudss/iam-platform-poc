import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), GATE = 'gate-token-1234', T = 'acme-demo', PW = 'demo-only-not-a-secret';

/** A stand-in for the directory: the flow only asks it three questions (is the account known, is the first-access rule in force, complete the change). It mirrors the real revision contract. */
class FakeUsers {
  revision = 'r1'; flagged = true; expired = false; completeCalls = 0; stateCalls = 0; loginEnabled = true; afterComplete?: () => Promise<void> | void; failListNow = false; policyOk = true; sameAsTemp = false;
  async list() { if (this.failListNow) throw new Error('directory read failed'); return [{ id: 'demo-alice', login_enabled: this.loginEnabled, hasCredential: true, email: 'alice@example.test', credential_revision: this.revision }]; }
  async passwordChangedAt() { return undefined; }
  async firstAccessState(_t: string, id: string) { this.stateCalls++; return id === 'demo-alice' && this.flagged ? { required: true as const, expired: this.expired, revision: this.revision } : { required: false as const }; }
  async completeFirstAccess(_t: string, _id: string, _next: string, expected: string) {
    this.completeCalls++;
    if (!this.flagged || expected !== this.revision) return { ok: false as const, reason: 'not-required' as const };
    if (this.expired) return { ok: false as const, reason: 'expired' as const };
    if (this.sameAsTemp) return { ok: false as const, reason: 'same-as-temporary' as const };
    if (!this.policyOk) return { ok: false as const, reason: 'policy' as const, errors: ['too short'] };
    this.revision = `r${this.completeCalls + 1}`; this.flagged = false; await this.afterComplete?.(); return { ok: true as const };
  }
}

describe('first access: forced password change inside the sign-in chain', () => {
  let app: INestApplication, svc: AuthnService, fake: FakeUsers; const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'fa-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService);
    fake = new FakeUsers(); (svc as any).users = fake;
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTH_GATE_TOKEN = env.g; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const gate = (b: object) => http().post('/internal/auth/authenticate').set('x-gate-token', GATE).send(b);
  const reset = () => { fake.revision = 'r1'; fake.flagged = true; fake.expired = false; fake.completeCalls = 0; fake.stateCalls = 0; fake.loginEnabled = true; fake.afterComplete = undefined; fake.failListNow = false; fake.policyOk = true; fake.sameAsTemp = false; };
  const put = (c: unknown) => http().put(`/tenants/${T}/auth`).set(adm).send({ config: c });
  const chain = { methods: [{ id: 'pw', type: 'password', name: 'pw', enabled: true, level: 3, config: {} }], chains: [{ id: 'pw-only', name: 'Password', steps: ['pw'], level: 3 }], defaultChain: 'pw-only' };
  const prevDir = process.env.IAM_DIRECTORY_AUTH;
  before(() => { process.env.IAM_DIRECTORY_AUTH = '1'; });
  after(() => { if (prevDir === undefined) delete process.env.IAM_DIRECTORY_AUTH; else process.env.IAM_DIRECTORY_AUTH = prevDir; });

  it('the password proof leads to a change challenge, never to an allow, and no claims leave before the change', async () => {
    await put(chain).expect(200); reset();
    const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body;
    assert.equal(c.outcome, 'challenge'); assert.equal(c.step.type, 'password-change'); assert.deepEqual(c.step.fields.map((f: any) => f.name), ['newpw', 'confirm']);
    assert.ok(!('claims' in c));
    assert.equal(fake.completeCalls, 0);
  });
  it('mismatching confirmation is refused without calling the directory; three failures end the attempt', async () => {
    reset(); const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    for (let i = 0; i < 2; i++) assert.equal((await gate({ tenant: T, session: c.session, answers: { newpw: 'aaaaaaaaaaaa', confirm: 'bbbbbbbbbbbb' } })).body.outcome, 'challenge');
    assert.equal((await gate({ tenant: T, session: c.session, answers: { newpw: 'aaaaaaaaaaaa', confirm: 'bbbbbbbbbbbb' } })).body.outcome, 'deny');
    assert.equal(fake.completeCalls, 0);
    assert.equal((await gate({ tenant: T, session: c.session, answers: { newpw: 'aaaaaaaaaaaa', confirm: 'aaaaaaaaaaaa' } })).body.outcome, 'deny', 'the ended session is not reusable');
  });
  it('a correct change consumes the flag and only then allows, with claims; the session is single use', async () => {
    reset(); const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    const ok = (await gate({ tenant: T, session: c.session, answers: { newpw: 'n3w-demo-only-pass', confirm: 'n3w-demo-only-pass' } })).body;
    assert.equal(ok.outcome, 'allow'); assert.equal(ok.subject, 'demo-alice'); assert.equal(fake.flagged, false);
    assert.equal((await gate({ tenant: T, session: c.session, answers: { newpw: 'n3w-demo-only-pass', confirm: 'n3w-demo-only-pass' } })).body.outcome, 'deny');
    const next = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    assert.equal(next.outcome, 'allow', 'with the flag consumed the next sign-in is normal');
  });
  it('policy and same-as-temporary refusals keep the challenge; expiry and a reset during the page end the session', async () => {
    reset(); let c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    fake.policyOk = false; let r = (await gate({ tenant: T, session: c.session, answers: { newpw: 'short', confirm: 'short' } })).body;
    assert.equal(r.outcome, 'challenge'); assert.match(r.error, /policy/);
    fake.policyOk = true; fake.sameAsTemp = true; r = (await gate({ tenant: T, session: c.session, answers: { newpw: 'x'.repeat(14), confirm: 'x'.repeat(14) } })).body;
    assert.equal(r.outcome, 'challenge'); assert.match(r.error, /different/);
    fake.sameAsTemp = false; fake.expired = true; r = (await gate({ tenant: T, session: c.session, answers: { newpw: 'x'.repeat(14), confirm: 'x'.repeat(14) } })).body;
    assert.equal(r.outcome, 'deny');
    reset(); c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    fake.revision = 'r9';   // an administrator reset the credential while the page was open
    r = (await gate({ tenant: T, session: c.session, answers: { newpw: 'x'.repeat(14), confirm: 'x'.repeat(14) } })).body;
    assert.equal(r.outcome, 'deny'); assert.equal(fake.flagged, true, 'the unproven revision is never consumed');
  });
  it('an expired temporary password is refused at the gate with no change page', async () => {
    reset(); fake.expired = true;
    const r = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    assert.equal(r.outcome, 'deny'); assert.equal(r.reason, 'password-change-expired');
  });
  it('a wrong first password reveals nothing about the rule', async () => {
    reset(); const r = (await gate({ tenant: T, subject: 'demo-alice', password: 'wrong' })).body;
    assert.deepEqual(r, { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' });
  });
  it('a directory error refuses closed', async () => {
    reset(); const orig = fake.firstAccessState; fake.firstAccessState = async () => { throw new Error('boom'); };
    try { const r = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body; assert.equal(r.outcome, 'deny'); assert.notEqual(r.outcome, 'allow'); }
    finally { fake.firstAccessState = orig; }
  });
  it('classic single-password mode refuses a flagged account and allows an unflagged one', async () => {
    await put({ methods: [], chains: [], defaultChain: null }).expect(200); reset();
    assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: PW })).body.reason, 'password-change-required');
    fake.flagged = false; assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: PW })).body.outcome, 'allow');
  });
  it('COMPATIBILITY only (not a security proof): outside directory mode the rule is never consulted, and a substituted password plugin with a flagged account is the reason the admin action refuses there', async () => {
    const was = process.env.IAM_DIRECTORY_AUTH; delete process.env.IAM_DIRECTORY_AUTH;
    try {
      await put({ methods: [], chains: [], defaultChain: null }).expect(200); reset();
      const r = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
      assert.equal(fake.stateCalls, 0, 'the directory is not asked about the rule without directory mode');
      assert.ok(!String(r.reason ?? '').startsWith('password-change'), 'no first-access refusal is produced outside directory mode');
    } finally { if (was === undefined) delete process.env.IAM_DIRECTORY_AUTH; else process.env.IAM_DIRECTORY_AUTH = was; }
  });
  const submit = (session: string) => gate({ tenant: T, session, answers: { newpw: 'n3w-demo-only-pass', confirm: 'n3w-demo-only-pass' } });
  for (const kind of ['suspended', 'locked'] as const) {
    it(`a ${kind} block placed after the challenge wins: refused, the temporary password is not consumed, no token, a fresh chain is needed`, async () => {
      await put(chain).expect(200);
      reset(); const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body; assert.equal(c.outcome, 'challenge');
      const b = await svc.blocks.add(T, { subject: 'demo-alice', kind, message: 'Held for the badge check.', origin: 'admin', setBy: 'admin-test', setAt: Date.now(), hold: true });
      try {
        const r = (await submit(c.session)).body;
        assert.equal(r.outcome, 'deny'); assert.ok(!('claims' in r) && !('code' in r) && !('token' in r));
        assert.equal(fake.completeCalls, 0, 'the temporary password is not consumed'); assert.equal(fake.flagged, true);
        assert.equal((await submit(c.session)).body.outcome, 'deny', 'the session is gone');
      } finally { await svc.blocks.lift(T, 'demo-alice', b.id); }
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: PW })).body.outcome, 'challenge', 'after the block is lifted a fresh chain shows the change again');
    });
  }
  it('a login disabled after the challenge wins: refused, nothing consumed', async () => {
    await put(chain).expect(200);
    reset(); const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body; assert.equal(c.outcome, 'challenge');
    fake.loginEnabled = false;
    const r = (await submit(c.session)).body;
    assert.equal(r.outcome, 'deny'); assert.equal(fake.completeCalls, 0); assert.equal(fake.flagged, true);
    assert.equal((await submit(c.session)).body.outcome, 'deny');
  });
  it('last check: a block observed at the final read refuses with no claims (the new password stays saved), and a directory error there refuses closed', async () => {
    await put(chain).expect(200);
    reset(); let c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    let b: { id: string } | undefined;
    fake.afterComplete = async () => { b = await svc.blocks.add(T, { subject: 'demo-alice', kind: 'suspended', message: 'Held for the badge check.', origin: 'admin', setBy: 'admin-test', setAt: Date.now(), hold: true }); };
    try {
      const r = (await submit(c.session)).body;
      assert.equal(r.outcome, 'deny'); assert.ok(!('claims' in r)); assert.equal(fake.completeCalls, 1); assert.equal(fake.flagged, false, 'the password change itself was completed');
    } finally { if (b) await svc.blocks.lift(T, 'demo-alice', b.id); }
    await put(chain).expect(200); reset(); c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    fake.afterComplete = () => { fake.failListNow = true; };
    const e = (await submit(c.session)).body;
    assert.equal(e.outcome, 'deny'); assert.ok(!('claims' in e));
  });
  it('two simultaneous submissions and a replay: at most one allow, the other is refused, nothing leaks', async () => {
    await put(chain).expect(200);
    reset(); const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    const [x, y] = await Promise.all([submit(c.session), submit(c.session)]);
    const allows = [x.body, y.body].filter((r: any) => r.outcome === 'allow').length;
    assert.ok(allows <= 1, 'never two allows from one challenge'); assert.equal(fake.completeCalls <= 1, true);
    assert.equal((await submit(c.session)).body.outcome, 'deny', 'replay after the session ended');
  });
  it('MFA: with a second factor in the chain the change page comes only AFTER every factor, the rule is not consulted before, and nothing is consumed until the change', async () => {
    const mfa = { methods: [{ id: 'pw', type: 'password', name: 'pw', enabled: true, level: 3, config: {} }, { id: 'pin', type: 'digit-code', name: 'pin', enabled: true, level: 3, config: {} }], chains: [{ id: 'pw-pin', name: 'Password then PIN', steps: ['pw', 'pin'], level: 4 }], defaultChain: 'pw-pin' };
    await put(mfa).expect(200); reset();
    (svc as any).fails.clear(); (svc as any).starts.clear();   // earlier tests in this file spent this account's throttle budget
    const pin = (await http().post(`/tenants/${T}/auth/enrollments/demo-alice/pin`).set(adm).send({ length: 6 }).expect(201)).body.shownOnce.pin as string;
    let r = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body;
    assert.equal(r.outcome, 'challenge'); assert.equal(r.step.methodId, 'pin', 'the second factor comes before the change page');
    assert.equal(fake.stateCalls, 0, 'the first-access rule is not consulted before the chain is complete'); assert.equal(fake.completeCalls, 0);
    for (const d of pin) { const id = r.step.fields[0].keys.find((k: any) => k.digit === d).id; r = (await gate({ tenant: T, session: r.session, answers: { key: id } })).body; assert.equal(r.outcome, 'challenge'); }
    r = (await gate({ tenant: T, session: r.session, answers: { action: 'submit' } })).body;
    assert.equal(r.outcome, 'challenge'); assert.equal(r.step.methodId, 'first-access-change'); assert.ok(!('claims' in r)); assert.equal(fake.completeCalls, 0);
    const done = (await submit(r.session)).body;
    assert.equal(done.outcome, 'allow'); assert.ok(done.claims.amr.includes('pin')); assert.equal(fake.completeCalls, 1);
  });
});
