import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
void PluginsV1Module;
import { SignupService } from './signup.service.js';
import { BlockStore } from '../accounts/block-store.js';
import { inForce } from '../accounts/blocks.js';

const make = (hold: boolean) => {
  const store = new BlockStore();
  const events: any[] = [];
  const authn = { liveSecurity: async () => ({ holdAfterVerification: hold }), blocks: store } as never;
  const s = new SignupService({} as never, undefined, authn, { emit: (e: unknown) => events.push(e) } as never);
  (s as any).manager = { approve: async (_t: string, id: string) => ({ id, approved: true }) };
  return { s, store, events };
};

describe('sign-up approval and the hold setting', () => {
  it('hold on: the new account is created blocked (pending approval, no end date) and the event goes out', async () => {
    const { s, store, events } = make(true);
    const out: any = await s.approve('t-hold-on', 'new.person', 'admin');
    assert.equal(out.approved, true);
    const b = inForce(await store.list('t-hold-on', 'new.person'), Date.now());
    assert.equal(b.length, 1); assert.equal(b[0].kind, 'pending_approval'); assert.equal(b[0].hold, true);
    assert.deepEqual(events.map((e) => [e.type, e.payload.subject, e.payload.kind]), [['user.blocked', 'new.person', 'pending_approval']]);
  });
  it('hold off (default): approval blocks nothing', async () => {
    const { s, store, events } = make(false);
    await s.approve('t-hold-off', 'new.person', 'admin');
    assert.equal((await store.list('t-hold-off', 'new.person')).length, 0); assert.equal(events.length, 0);
  });
});
