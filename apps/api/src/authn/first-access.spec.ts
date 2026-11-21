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
  revision = 'r1'; flagged = true; expired = false; completeCalls = 0; policyOk = true; sameAsTemp = false;
  async list() { return [{ id: 'demo-alice', login_enabled: true, hasCredential: true, email: 'alice@example.test', credential_revision: this.revision }]; }
  async passwordChangedAt() { return undefined; }
  async firstAccessState(_t: string, id: string) { return id === 'demo-alice' && this.flagged ? { required: true as const, expired: this.expired, revision: this.revision } : { required: false as const }; }
  async completeFirstAccess(_t: string, _id: string, _next: string, expected: string) {
    this.completeCalls++;
    if (!this.flagged || expected !== this.revision) return { ok: false as const, reason: 'not-required' as const };
    if (this.expired) return { ok: false as const, reason: 'expired' as const };
    if (this.sameAsTemp) return { ok: false as const, reason: 'same-as-temporary' as const };
    if (!this.policyOk) return { ok: false as const, reason: 'policy' as const, errors: ['too short'] };
    this.revision = `r${this.completeCalls + 1}`; this.flagged = false; return { ok: true as const };
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
  const reset = () => { fake.revision = 'r1'; fake.flagged = true; fake.expired = false; fake.completeCalls = 0; fake.policyOk = true; fake.sameAsTemp = false; };
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
});
