import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../plugins/v1/plugins-v1.module.js';
import { AuthnService } from './flow.service.js';
import { parseSecurity } from '../accounts/security-config.js';

/** saveAppLevel only needs a registry with the core settings: a fake one holds them. */
function harness(initial: Record<string, unknown> | undefined) {
  const box = { value: initial, writes: 0 };
  const reg = { coreSettings: async () => box.value, putCoreSettings: async (_t: string, _id: string, v: Record<string, unknown>) => { box.value = v; box.writes++; } };
  const self = { registry: async () => reg };
  return { box, save: (app: string, level: unknown) => (AuthnService.prototype.saveAppLevel as any).call(self, 't', app, level) };
}
const stored = { lockout: { enabled: true, maxFailures: 7, windowSeconds: 600, lockSeconds: 900, hold: false }, adminMinLevel: 4, adminMaxAgeSeconds: 600, holdAfterVerification: true, appLevels: { finance: { minLevel: 5, maxAgeSeconds: 300 }, hr: { minLevel: 3 } } };

describe('saveAppLevel (application edit form)', () => {
  it('changes only that minLevel, in one write; age limit, other apps and other settings stay', async () => {
    const h = harness(stored); await h.save('finance', 8);
    const c = parseSecurity(h.box.value);
    assert.equal(h.box.writes, 1); assert.deepEqual(c.appLevels.finance, { minLevel: 8, maxAgeSeconds: 300 }); assert.deepEqual(c.appLevels.hr, { minLevel: 3 });
    assert.equal(c.adminMinLevel, 4); assert.equal(c.adminMaxAgeSeconds, 600); assert.equal(c.lockout.maxFailures, 7); assert.equal(c.holdAfterVerification, true);
  });
  it('level 0 removes the minimum but keeps a stored age limit (no effect while 0); without one the entry goes', async () => {
    const h = harness(stored); await h.save('finance', 0); await h.save('hr', 0);
    const c = parseSecurity(h.box.value);
    assert.deepEqual(c.appLevels.finance, { minLevel: 0, maxAgeSeconds: 300 }); assert.equal('hr' in c.appLevels, false);
  });
  it('a new application gets a level; bad levels and bad ids are refused with no write', async () => {
    const h = harness(undefined); await h.save('crm', 6); assert.deepEqual(parseSecurity(h.box.value).appLevels.crm, { minLevel: 6 });
    const w = h.box.writes;
    for (const l of [11, -1, 2.5, '5', null]) await assert.rejects(h.save('crm', l));
    await assert.rejects(h.save('Bad Id', 5));
    assert.equal(h.box.writes, w);
  });
});
