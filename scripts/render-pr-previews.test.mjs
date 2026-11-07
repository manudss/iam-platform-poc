// Unit tests for scripts/render-pr-previews.mjs with a mocked global fetch (no network,
// no secrets). Run: node --test scripts/render-pr-previews.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let importCounter = 0;
const SHA = 'a'.repeat(40);
const BASE_ENV = {
  RENDER_API_KEY: 'test-key',
  RENDER_OWNER_ID: 'tea-test',
  RENDER_ENVIRONMENT_ID: 'evm-test',
  GITHUB_TOKEN: 'ghp-test',
  GITHUB_REPOSITORY: 'manudss/iam-platform-poc',
  PR_NUMBER: '3',
};

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const r = await handler(u, opts);
    return r ?? { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  return calls;
}
const json200 = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
const liveDeploy = () => json200([{ deploy: { id: 'dep-1', status: 'live', createdAt: new Date().toISOString() } }]);
const openPr = (over = {}) => json200({
  state: 'open',
  head: { ref: 'feature/x', sha: SHA, repo: { full_name: 'manudss/iam-platform-poc' } },
  ...over,
});

async function load(env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('RENDER_') || k.startsWith('PR_') || k.startsWith('PREVIEW_') || k === 'GITHUB_TOKEN' || k === 'GITHUB_REPOSITORY' || k === 'DRY_RUN' || k === 'GH_DRY') delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  process.argv[2] = env.MODE ?? 'ensure'; // the script reads its mode from argv
  return import(`./render-pr-previews.mjs?case=${importCounter++}`);
}

const renderCalls = (calls, method, re) => calls.filter((c) => c.method === method && re.test(c.url));
const ghCalls = (calls, method, re) => calls.filter((c) => c.method === method && c.url.includes('api.github.com') && re.test(c.url));

test('rejects an invalid PR_NUMBER', async () => {
  await assert.rejects(load({ PR_NUMBER: 'abc' }), /PR_NUMBER invalid/);
});
test('rejects an invalid GITHUB_REPOSITORY', async () => {
  await assert.rejects(load({ GITHUB_REPOSITORY: 'a/b/c' }), /GITHUB_REPOSITORY invalid/);
});

// --- ensure: deploy on demand means a push never builds ---

test('ensure with no service writes nothing to Render and comments the how-to', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    return json200([]); // GET /services?name=... -> no existing service
  });
  const m = await load();
  await m.ensure();
  assert.equal(renderCalls(calls, 'POST', /\/v1\/services/).length, 0, 'no service creation');
  assert.equal(renderCalls(calls, 'POST', /\/deploys/).length, 0, 'no deploy');
  assert.equal(renderCalls(calls, 'PUT', /.*/).length + renderCalls(calls, 'DELETE', /.*/).length, 0, 'no other Render write');
  assert.equal(ghCalls(calls, 'GET', /\/pulls\/3/).length, 0, 'ensure does not need the PR head');
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /render-previews-iam/);
  assert.match(comments[0].body.body, /\/preview/, 'comment tells how to deploy on demand');
  assert.doesNotMatch(comments[0].body.body, /onrender\.com/, 'no URL before any preview exists: a placeholder link would be dead');
  assert.match(comments[0].body.body, /publiee ici automatiquement/, 'comment explains the URL comes once live');
});

test('ensure with an existing service keeps the link, adds the refresh how-to, and never deploys', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    if (u.includes('/deploys')) return liveDeploy();
    return json200({});
  });
  const m = await load();
  await m.ensure();
  assert.equal(renderCalls(calls, 'POST', /\/deploys/).length, 0, 'a push must not start a build');
  assert.equal(renderCalls(calls, 'GET', /\/services\/srv-old\/deploys/).length, 1, 'live state checked before showing links');
  assert.equal(renderCalls(calls, 'PUT', /env-vars/).length, 0, 'no env rewrite from ensure');
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /https:\/\/iam-pr3\.onrender\.com/);
  assert.match(comments[0].body.body, /\/preview/);
});

test('ensure updates an existing marked comment instead of posting a new one', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([{ id: 42, body: '<!-- render-previews-iam -->\nold' }]);
    return json200([]);
  });
  const m = await load();
  await m.ensure();
  assert.equal(ghCalls(calls, 'PATCH', /\/issues\/comments\/42/).length, 1);
  assert.equal(ghCalls(calls, 'POST', /\/issues\/3\/comments/).length, 0);
});

// --- refresh: explicit on-demand deploy ---

test('refresh reads the head from the pulls API and creates the service once, with autoDeploy off', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/deploys') && (opts.method ?? 'GET') === 'GET') return liveDeploy();
    if (u.includes('/services') && !u.includes('name=')) return json200({ service: { id: 'srv-new', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } });
    return json200([]); // GET /services?name=... -> no existing service
  });
  const m = await load({ MODE: 'refresh', PREVIEW_POLL_MS: '1' });
  await m.refresh();
  assert.equal(ghCalls(calls, 'GET', /\/pulls\/3/).length, 1, 'head read back from the API');
  const creates = renderCalls(calls, 'POST', /\/v1\/services$/);
  assert.equal(creates.length, 1, 'exactly one service creation');
  const body = creates[0].body;
  assert.equal(body.autoDeploy, 'no', 'autoDeploy must stay off: the workflow explicit deploy is the single trigger');
  assert.equal(body.environmentId, 'evm-test');
  assert.equal(body.ownerId, 'tea-test');
  assert.equal(body.branch, 'feature/x');
  assert.equal(body.type, 'web_service');
  assert.equal(body.name, 'iam-pr3');
  assert.equal(body.serviceDetails.runtime, 'docker');
  assert.equal(body.serviceDetails.plan, 'free');
  assert.equal(body.serviceDetails.region, 'frankfurt');
  assert.equal(body.serviceDetails.healthCheckPath, '/healthz');
  assert.deepEqual(body.serviceDetails.envSpecificDetails, { dockerfilePath: 'demo/Dockerfile', dockerContext: '.' });
  assert.deepEqual(body.envVars, [{ key: 'IAM_PUBLIC_ORIGIN', value: 'https://iam-pr3.onrender.com' }], 'only non-secret env var');
  assert.equal(renderCalls(calls, 'POST', /\/deploys/).length, 0, 'no explicit deploy on creation: Render deploys on create');
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 2, 'immediate ack, then the live announcement');
  assert.match(comments[0].body.body, /aaaaaaa/, 'ack comment names the building short sha');
  assert.doesNotMatch(comments[0].body.body, /onrender\.com/, 'ack shows no URL while the build is only starting');
  assert.match(comments[1].body.body, /Preview en ligne/, 'second comment announces the live preview');
  assert.match(comments[1].body.body, /https:\/\/iam-pr3\.onrender\.com/, 'URL published only once live');
});

test('refresh on an existing service triggers exactly one explicit deploy when the origin is unchanged', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://iam-pr3.onrender.com' } }]);
    if (u.includes('/deploys') && (opts.method ?? 'GET') === 'GET') return liveDeploy();
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load({ MODE: 'refresh', PREVIEW_POLL_MS: '1' });
  await m.refresh();
  assert.equal(renderCalls(calls, 'POST', /\/v1\/services$/).length, 0, 'no second creation');
  assert.equal(renderCalls(calls, 'POST', /\/services\/srv-old\/deploys/).length, 1, 'exactly one explicit deploy: no double build');
  assert.equal(renderCalls(calls, 'PUT', /env-vars/).length, 0, 'no env update when origin already right');
});

test('refresh with a changed URL updates the env var and does NOT also trigger a deploy', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://old.onrender.com' } }]);
    if (u.includes('/deploys') && (opts.method ?? 'GET') === 'GET') return liveDeploy();
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load({ MODE: 'refresh', PREVIEW_POLL_MS: '1' });
  await m.refresh();
  assert.equal(renderCalls(calls, 'PUT', /\/services\/srv-old\/env-vars\/IAM_PUBLIC_ORIGIN/).length, 1);
  assert.equal(renderCalls(calls, 'POST', /\/deploys/).length, 0, 'env change redeploys by itself: no second trigger');
});

test('refresh refuses a fork PR', async () => {
  mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr({ head: { ref: 'feature/x', sha: SHA, repo: { full_name: 'someone/else' } } });
    return json200([]);
  });
  const m = await load({ MODE: 'refresh' });
  await assert.rejects(m.refresh(), /fork/);
});

test('refresh refuses a closed PR', async () => {
  mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr({ state: 'closed' });
    return json200([]);
  });
  const m = await load({ MODE: 'refresh' });
  await assert.rejects(m.refresh(), /not open/);
});

test('refresh skips cleanly when the branch has no demo/Dockerfile', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return notFound;
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    return json200([]);
  });
  const m = await load({ MODE: 'refresh' });
  await m.refresh();
  assert.equal(renderCalls(calls, 'POST', /\/v1\/services/).length, 0, 'no Render write at all');
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /demo\/Dockerfile/);
});


test('ensure with an existing service whose deploy is not live shows no URL', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    if (u.includes('/deploys')) return json200([{ deploy: { id: 'dep-1', status: 'build_failed', createdAt: new Date().toISOString() } }]);
    return json200({});
  });
  const m = await load();
  await m.ensure();
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.doesNotMatch(comments[0].body.body, /onrender\.com/, 'no URL while the latest deploy is not live');
  assert.match(comments[0].body.body, /build_failed/, 'comment states the deploy status instead');
});

test('refresh publishes a failure note without links when the build fails', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://iam-pr3.onrender.com' } }]);
    if (u.includes('/deploys') && (opts.method ?? 'GET') === 'GET') return json200([{ deploy: { id: 'dep-9', status: 'build_failed', createdAt: new Date().toISOString() } }]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load({ MODE: 'refresh', PREVIEW_POLL_MS: '1' });
  await m.refresh();
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 2, 'ack, then the failure note');
  assert.match(comments[1].body.body, /echoue/, 'failure is reported');
  assert.match(comments[1].body.body, /build_failed/, 'with the Render status');
  assert.doesNotMatch(comments[1].body.body, /onrender\.com/, 'no URL on a failed build');
});

test('refresh notes it on the PR without links when the deploy watch times out', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/pulls/3')) return openPr();
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://iam-pr3.onrender.com' } }]);
    if (u.includes('/deploys') && (opts.method ?? 'GET') === 'GET') return json200([{ deploy: { id: 'dep-9', status: 'build_in_progress', createdAt: new Date().toISOString() } }]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load({ MODE: 'refresh', PREVIEW_POLL_MS: '1', PREVIEW_WAIT_MAX_MS: '5' });
  await m.refresh();
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 2, 'ack, then the timeout note');
  assert.match(comments[1].body.body, /toujours en cours/, 'timeout is reported as still building');
  assert.doesNotMatch(comments[1].body.body, /onrender\.com/, 'no URL while nothing is live');
});

// --- cleanup: unchanged ---


test('workflow never pins trusted-code checkouts to pull_request metadata (stale base.sha ran an old script)', () => {
  // pull_request_target reads the workflow from the default branch head, but
  // github.event.pull_request.base.sha in the event payload can lag behind it: an ensure checkout pinned
  // to it ran an OLDER render-pr-previews.mjs (whose ensure guard required PR_HEAD_BRANCH, no longer
  // passed) and failed every synchronize. Trusted code must always come from the default branch head,
  // exactly like the workflow file itself — so no checkout may take a ref from pull_request metadata.
  const wf = readFileSync(new URL('../.github/workflows/pr-previews.yml', import.meta.url), 'utf8');
  assert.ok((wf.match(/uses: actions\/checkout@/g) ?? []).length >= 3, 'expected several checkout steps');
  assert.ok(!/ref:\s*\$\{\{\s*github\.event\.pull_request/.test(wf), 'a checkout must never take its ref from pull_request event metadata');
});

test('cleanup deletes the service and comments', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3' } }]);
    return json200({});
  });
  const m = await load();
  await m.cleanup();
  assert.equal(renderCalls(calls, 'DELETE', /\/services\/srv-old/).length, 1);
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /supprime/);
});

test('cleanup is a no-op on Render when the service does not exist', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    return json200([]);
  });
  const m = await load();
  await m.cleanup();
  assert.equal(renderCalls(calls, 'DELETE', /\/services\//).length, 0);
});
