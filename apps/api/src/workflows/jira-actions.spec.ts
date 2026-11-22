import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { externalBlock } from './model.js';

// The three Jira blocks run the REAL Activepieces jira-cloud piece against a LOCAL fake Jira server (loopback, free, no credential).
// What this shows: the piece builds the expected REST calls and the block maps the replies. It does not show behaviour against a real Jira site.
async function withFakeJira(fn: (url: string, seen: { method: string; url: string; body: string }[]) => Promise<void>) {
  const seen: { method: string; url: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: b });
      res.setHeader('content-type', 'application/json');
      if ((req.url ?? '').includes('/comment')) res.end(JSON.stringify({ id: '777' }));
      else if ((req.url ?? '').includes('/transitions')) { res.statusCode = 204; res.end(); }
      else res.end(JSON.stringify({ key: 'KAN-1', fields: { status: { name: 'Done' }, summary: 's', labels: ['a', 'b'] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen); } finally { srv.close(); }
}
const ctx = (config: unknown, settings: unknown, dryRun = false) => ({ tenant: 'acme', config, settings, dryRun, log: () => {}, outputs: {} }) as never;
const settings = (url: string) => ({ jiraInstanceUrl: url, jiraEmail: 'tester@example.invalid', jiraApiToken: 'TEST-TOKEN' });

describe('jira get / comment / transition blocks', () => {
  it('default dryRun calls nothing', async () => {
    await withFakeJira(async (url, seen) => {
      for (const [t, c] of [['jira-get-issue', { project: 'KAN', issueKey: 'KAN-1' }], ['jira-add-comment', { project: 'KAN', issueKey: 'KAN-1', comment: 'x' }], ['jira-transition-issue', { project: 'KAN', issueKey: 'KAN-1', transitionId: '31' }]] as const) {
        const b = externalBlock(t)!; const out = await b.run(ctx(b.validate(c), settings(url)));
        assert.equal((out as { dryRun?: boolean }).dryRun, true);
      }
      assert.equal(seen.length, 0);
    });
  });
  it('real mode: read, comment and transition map to the Jira REST calls and replies', async () => {
    await withFakeJira(async (url, seen) => {
      const g = externalBlock('jira-get-issue')!, c = externalBlock('jira-add-comment')!, t = externalBlock('jira-transition-issue')!;
      assert.deepEqual(await g.run(ctx(g.validate({ dryRun: false, project: 'KAN', issueKey: 'KAN-1' }), settings(url))), { key: 'KAN-1', status: 'Done', summary: 's', labels: 'a,b' });
      assert.deepEqual(await c.run(ctx(c.validate({ dryRun: false, project: 'KAN', issueKey: 'KAN-1', comment: 'hello' }), settings(url))), { commentId: '777' });
      assert.deepEqual(await t.run(ctx(t.validate({ dryRun: false, project: 'KAN', issueKey: 'KAN-1', transitionId: '31' }), settings(url))), { transitioned: true });
      assert.ok(seen.some((s) => s.method === 'POST' && s.url === '/rest/api/3/issue/KAN-1/comment' && s.body.includes('hello')));
      assert.ok(seen.some((s) => s.method === 'POST' && s.url === '/rest/api/3/issue/KAN-1/transitions' && JSON.parse(s.body).transition.id === '31'));
    });
  });
  it('without a managed connection a real call is refused before any request', async () => {
    const c = externalBlock('jira-add-comment')!;
    await assert.rejects(c.run(ctx(c.validate({ dryRun: false, project: 'KAN', issueKey: 'KAN-1', comment: 'x' }), {})), /managed Jira connection/);
  });
  it('validation refuses a malformed key or transition id and an empty comment', () => {
    assert.throws(() => externalBlock('jira-get-issue')!.validate({ project: 'KAN', issueKey: 'kan 1' }));
    assert.throws(() => externalBlock('jira-transition-issue')!.validate({ project: 'KAN', issueKey: 'KAN-1', transitionId: 'Done' }));
    assert.throws(() => externalBlock('jira-add-comment')!.validate({ project: 'KAN', issueKey: 'KAN-1', comment: '' }));
  });
});
