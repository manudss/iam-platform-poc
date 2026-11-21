import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowJiraDonePollerService } from './jira-done-poller.js';
// Stubs only: no Jira, no database. Shows one run per ticket key (stable event id), the connection use and idle cases.
const def = (over: any = {}) => ({ id: 'wf-badge', tenant: 'acme', active: true, trigger: { event: 'jira.issue-done', config: { connectionId: 'conn-1', project: 'KAN' } }, ...over });
function build(defs: any[], tickets: any[], starts: any[]) {
  const store: any = { liveRef: 'main', listAllDefinitions: async () => defs };
  const wf: any = { start: async (t: string, id: string, sub: string, ev: any) => { starts.push({ t, id, sub, ev }); return { run: { id: 'run-x', status: 'done' } }; } };
  const reg: any = { isActive: () => true, impl: () => ({}) };
  const connections: any = { resolve: async (_t: string, _b: string, id: string, provider: string) => { assert.equal(provider, 'jira'); assert.equal(id, 'conn-1'); return { settings: { jiraInstanceUrl: 'https://team.atlassian.net', jiraEmail: 'a@b.test', jiraApiToken: 'x' } }; } };
  return new WorkflowJiraDonePollerService(store, wf, reg, undefined, connections);
}
describe('jira done watcher', () => {
  it('uses the stub poll through the real trigger and starts one run per ticket keyed by the ticket key', async () => {
    const { externalEvent } = await import('./model.js');
    const ev: any = externalEvent('jira.issue-done');
    const orig = ev.poll;
    ev.poll = async () => [{ key: 'KAN-7', values: { key: 'KAN-7', summary: 'Badge', status: 'Done', updated: 'u' } }];
    try {
      const starts: any[] = [];
      const svc = build([def()], [], starts);
      await svc.tick(); await svc.tick();
      assert.equal(starts.length, 2, 'the service asks twice; the engine returns the same run for the same event id');
      assert.equal(starts[0].ev.eventId, starts[1].ev.eventId);
      assert.equal(starts[0].ev.payload.key, 'KAN-7');
      assert.equal(starts[0].sub, 'jira-done-watcher');
    } finally { ev.poll = orig; }
  });
  it('stays idle without a managed connection or when the definition is paused', async () => {
    const starts: any[] = [];
    await build([def({ trigger: { event: 'jira.issue-done', config: {} } }), def({ active: false })], [], starts).tick();
    assert.equal(starts.length, 0);
  });
});
