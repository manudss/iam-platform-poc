import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../plugins/v1/plugins-v1.module.js';
import { AuthnService } from './flow.service.js';
import { DEFAULT_SECURITY } from '../accounts/security-config.js';
import { appRequirement } from './step-up.js';

const svc = () => {
  const s = new AuthnService({} as never); s.now = () => 10_000_000;
  (s as any).liveSecurity = async () => ({ ...DEFAULT_SECURITY, appLevels: { finance: { minLevel: 8 }, fresh: { minLevel: 3, maxAgeSeconds: 60 } } });
  (s as any).stepUpOptions = async () => [{ id: 'mfa', name: 'Password then authenticator', effectiveLevel: 8 }];
  return s;
};
describe('application level rule', () => {
  it('an application without a rule always opens', async () => assert.deepEqual(await svc().appAssurance('t', 'wiki', 'a', { auth_level: 3 }), { ok: true }));
  it('finance needs level 8: a level 3 session is asked to step up, offered only chains that reach it', async () => {
    const r: any = await svc().appAssurance('t', 'finance', 'a', { auth_level: 3, auth_time: 9_999_000 });
    assert.equal(r.ok, false); assert.equal(r.code, 'step-up-required'); assert.equal(r.requiredLevel, 8); assert.equal(r.currentLevel, 3); assert.deepEqual(r.chains.map((c: any) => c.id), ['mfa']); assert.equal(r.app, 'finance');
  });
  it('a level 8 session opens it', async () => assert.deepEqual(await svc().appAssurance('t', 'finance', 'a', { auth_level: 8 }), { ok: true }));
  it('freshness: an old sign-in at a sufficient level is asked again', async () => {
    assert.equal(((await svc().appAssurance('t', 'fresh', 'a', { auth_level: 5, auth_time: 9_000 })) as any).reason, 'age');
    assert.deepEqual(await svc().appAssurance('t', 'fresh', 'a', { auth_level: 5, auth_time: 9_990 }), { ok: true });
  });
  it('a missing level counts as zero, never as enough', async () => assert.equal(((await svc().appAssurance('t', 'finance', 'a', {})) as any).currentLevel, 0));
  it('level 0 means no rule', () => assert.equal(appRequirement({ x: { minLevel: 0 } }, 'x'), undefined));
});

describe('a level nobody can reach is refused upstream, never ignored at sign-in', () => {
  const cfg = (enabled: boolean) => ({ methods: [{ id: 'pw', enabled, level: 3 }], chains: [{ id: 'c', steps: ['pw'] }] }) as never;
  it('the live rule stays enforced even when the level is unreachable', async () => {
    const s = new AuthnService({} as never); s.now = () => 10_000_000;
    (s as any).liveSecurity = async () => ({ ...DEFAULT_SECURITY, adminMinLevel: 5 });
    assert.equal((await s.adminAssurance('t', { auth_level: 3 })).ok, false);
  });
  it('Apply is refused for an unreachable administration level and names why', async () => {
    const s = new AuthnService({} as never);
    (s as any).signinSecurity = async () => ({ ...DEFAULT_SECURITY, adminMinLevel: 5 });
    (s as any).signinConfig = async () => ({ methods: [], chains: [] });
    assert.match((await s.applyBlocker('t', 'work')) ?? '', /Administration level 5/);
  });
  it('Apply is refused for an unreachable application level', async () => {
    const s = new AuthnService({} as never);
    (s as any).signinSecurity = async () => ({ ...DEFAULT_SECURITY, appLevels: { finance: { minLevel: 8 } } });
    (s as any).signinConfig = async () => ({ methods: [], chains: [] });
    assert.match((await s.applyBlocker('t', 'main')) ?? '', /finance/);
  });
  it('a reachable level or no rule passes', async () => {
    const s = new AuthnService({} as never);
    (s as any).signinSecurity = async () => ({ ...DEFAULT_SECURITY, adminMinLevel: 0 });
    (s as any).signinConfig = async () => ({ methods: [], chains: [] });
    assert.equal(await s.applyBlocker('t', 'work'), null);
  });
  it('a chain with a disabled method does not count, and no chain means unreachable', () => {
    assert.equal(AuthnService.reachable(cfg(false), 1), false);
    assert.equal(AuthnService.reachable({ methods: [], chains: [] } as never, 1), false);
  });
});
