import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { externalEvent, validateTrigger } from './model.js';
const jira = loadPluginModule('workflow-connectors', 'jira-api.mjs') as any;
// Fake fetch: no Jira account and no network are involved. This proves the query, the host rules and the
// shape of what the watcher returns, not access to a live Jira.
const GATEWAY = 'https://api.atlassian.com/ex/jira/9963bb3b-629b-4729-b37a-c71e6fc94882';
const settings = { jiraInstanceUrl: GATEWAY, jiraEmail: 'demo@example.test', jiraApiToken: 'test-token-not-real' };
const fake = (status: number, body: unknown, seen: any[] = []) => async (url: string, init: any) => { seen.push({ url, init }); return { status, json: async () => body } as any; };

describe('jira.issue-done trigger', () => {
  it('is merged into the trigger catalogue with a poll function', () => {
    const ev = externalEvent('jira.issue-done');
    assert.ok(ev?.poll);
    assert.ok(ev!.configFields?.some((f: any) => f.key === 'connectionId'));
  });
  it('builds a read-only JQL for the project, label, done status and a bounded look-back', () => {
    assert.equal(jira.doneJql({ project: 'KAN', label: 'badge-demo' }), 'project = KAN AND labels = "badge-demo" AND status = "Done" AND updated >= -7d ORDER BY updated ASC');
    assert.equal(jira.doneJql({ project: 'KAN', lookbackDays: 500 }).includes('-30d'), true);
  });
  it('refuses a project or label that could change the query', () => {
    assert.throws(() => jira.doneJql({ project: 'KAN OR project = X' }));
    assert.throws(() => jira.doneJql({ project: 'KAN', label: 'a" OR "b' }));
  });
  it('only accepts the site origin or the gateway of a site', () => {
    assert.ok(jira.isJiraBase('https://demo.atlassian.net/'));
    assert.ok(jira.isJiraBase(GATEWAY));
    for (const u of ['http://demo.atlassian.net', 'https://evil.example/', 'https://api.atlassian.com/ex/jira/not-a-uuid', 'https://api.atlassian.com/other', 'https://demo.atlassian.net.evil.example/', 'https://u:p@demo.atlassian.net/'])
      assert.equal(jira.isJiraBase(u), false, u);
  });
  it('searches once through the gateway, sends the token only as Basic auth and returns plain ticket values', async () => {
    const seen: any[] = [];
    const out = await jira.readDoneIssues(settings, { project: 'KAN', label: 'badge-demo' }, fake(200, { issues: [{ id: '10', key: 'KAN-7', fields: { summary: 'Badge Camille', status: { name: 'Done' }, updated: '2026-11-21T14:00:00.000+0100' } }, { key: 'bad key', fields: {} }] }, seen));
    assert.deepEqual(out, [{ key: 'KAN-7', id: '10', values: { key: 'KAN-7', summary: 'Badge Camille', status: 'Done', updated: '2026-11-21T14:00:00.000+0100' } }]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${GATEWAY}/rest/api/3/search/jql`);
    assert.equal(seen[0].init.redirect, 'manual');
    assert.ok(!seen[0].url.includes('test-token-not-real') && !String(seen[0].init.body).includes('test-token-not-real'));
  });
  it('errors never carry the credential, and an unknown host is refused before any call', async () => {
    await assert.rejects(() => jira.readDoneIssues(settings, { project: 'KAN' }, fake(401, {})), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('test-token-not-real'));
    let called = 0;
    await assert.rejects(() => jira.readDoneIssues({ ...settings, jiraInstanceUrl: 'https://evil.example' }, { project: 'KAN' }, async () => { called++; return {} as any; }));
    assert.equal(called, 0);
  });
});
