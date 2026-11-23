import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
void PluginsV1Module;
import { SignupService } from './signup.service.js';
import { MemorySignupRequestStore } from './signup-request-store.js';

describe('signup finalization verifies actual published account state', () => {
  it('refuses changed identity, missing credential, changed revision or profile; only exact live state finalizes', async () => {
    const queue = new MemorySignupRequestStore();
    await queue.save('acme', 0, [{ tenant: 'acme', id: 'fiction', display_name: 'Fiction', email: 'fiction@example.invalid', values: { field: 'reviewed' }, salt: 'salt', hash: 'hash', tokenHash: 'tokenhash', confirmed: true, at: Date.now(), staged: { run: 'run-1', branch: 'workflow/one', actor: 'admin', state: 'prepared', revision: 'revision-1' } }]);
    const valid = { id: 'fiction', display_name: 'Fiction', email: 'fiction@example.invalid', login_enabled: true, credential_revision: 'revision-1', hasCredential: true };
    let live: any = valid, profileMatches = true; const events: any[] = [];
    const profile = { verifyPublishedSignup: async () => profileMatches };
    const users = { list: async (ref: string) => { assert.equal(ref, 'main'); return live ? [live] : []; } };
    const svc = () => new SignupService(profile as never, users as never, undefined, { emit: (e: any) => events.push(e) } as never, undefined, queue);
    for (const changed of [null, { ...valid, display_name: 'Other' }, { ...valid, email: 'other@example.invalid' }, { ...valid, login_enabled: false }, { ...valid, credential_revision: 'revision-2' }, { ...valid, hasCredential: false }]) {
      live = changed; await assert.rejects(svc().finalize('acme', 'fiction', 'admin', 'run-1'), /not effectively published/);
    }
    live = valid; profileMatches = false;
    await assert.rejects(svc().finalize('acme', 'fiction', 'admin', 'run-1'), /not effectively published/);
    assert.equal(events.length, 0);
    profileMatches = true;
    assert.equal((await svc().finalize('acme', 'fiction', 'admin', 'run-1') as any).finalized, true);
    assert.equal(events.filter(e => e.type === 'signup.approved').length, 1);
    assert.equal((await svc().finalize('acme', 'fiction', 'admin', 'run-1') as any).resumed, true);
    assert.equal(events.filter(e => e.type === 'signup.approved').length, 1);
    const persisted = (await queue.load('acme')).requests[0];
    assert.equal(persisted.hash, ''); assert.equal(persisted.salt, ''); assert.equal(persisted.tokenHash, '');
  });
});
