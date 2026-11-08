import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from './config.js';
import { methodType, methodTypes } from './methods.js';
import { validateManifest } from '../plugins/v1/manifest.js';

const m = (id: string, type: string, level: number, config: Record<string, unknown> = {}) => ({ id, type, name: id, enabled: true, level, config });
const cfg = (methods: any[], chains: any[] = []) => ({ methods, chains, defaultChain: null });

describe('method instances: single or multiple per type (auth methods rework)', () => {
  it('the password type is declared single-instance by its plugin; the other implemented types allow several', () => {
    assert.equal(methodType('password')?.instances, 'single');
    for (const id of ['totp', 'email-otp', 'digit-code']) assert.equal(methodType(id)?.instances, 'multiple', id);
    assert.ok(methodTypes().every((t) => t.instances === 'single' || t.instances === 'multiple'));
  });
  it('a configuration may hold several instances of a multiple type, each with its own settings', () => {
    const c = validateConfig(cfg([m('pin-4', 'digit-code', 2, { length: 4 }), m('pin-6', 'digit-code', 3, { length: 6 })]));
    assert.deepEqual(c.methods.map((x) => x.config.length), [4, 6]);
  });
  it('a second instance of a single type is refused with a clear message', () => {
    assert.throws(() => validateConfig(cfg([m('password', 'password', 3), m('password-2', 'password', 3)])), /allows a single instance/);
  });
  it('the manifest field instances only accepts single or multiple', () => {
    const base: any = { apiVersion: 'plugin/v3', id: 'x-method', version: '1.0.0', name: 'x', publisher: 'p', kinds: ['auth-method'], provides: ['auth.x'], hooks: [], settings: [],
      authMethod: { name: 'x', description: 'd', factor: 'knowledge', amr: 'pwd', maturity: 'implemented', suggestedLevel: 3, provisioning: 'none', instances: 'several' } };
    const errs = validateManifest(base, new Map());
    assert.ok(errs.some((e) => /authMethod.instances/.test(e)), errs.join(' | '));
    base.authMethod.instances = 'single';
    assert.ok(!validateManifest(base, new Map()).some((e) => /authMethod.instances/.test(e)));
  });
});
