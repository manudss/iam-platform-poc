// Unit tests for scripts/render-pr-previews.mjs with a mocked global fetch (no network,
// no secrets). Run: node --test scripts/render-pr-previews.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

let importCounter = 0;
const SHA = 'a'.repeat(40);
const BASE_ENV = {
  RENDER_API_KEY: 'test-key',
  RENDER_OWNER_ID: 'tea-test',
  RENDER_ENVIRONMENT_ID: 'evm-test',
  GITHUB_TOKEN: 'ghp-test',
  GITHUB_REPOSITORY: 'manudss/iam-platform-poc',
  PR_NUMBER: '3',
  PR_HEAD_BRANCH: 'feature/x',
  PR_HEAD_SHA: SHA,
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

async function load(env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('RENDER_') || k.startsWith('PR_') || k === 'GITHUB_TOKEN' || k === 'GITHUB_REPOSITORY' || k === 'DRY_RUN' || k === 'GH_DRY') delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  process.argv[2] = env.MODE ?? 'ensure'; // the script reads its mode from argv
  return import(`./render-pr-previews.mjs?case=${importCounter++}`);
}

const renderCalls = (calls, method, re) => calls.filter((c) => c.method === method && re.test(c.url));
const ghCalls = (calls, method, re) => calls.filter((c) => c.method === method && c.url.includes('api.github.com') && re.test(c.url));

test('rejects an invalid PR_HEAD_BRANCH', async () => {
  await assert.rejects(load({ PR_HEAD_BRANCH: 'bad;branch' }), /PR_HEAD_BRANCH rejected/);
});
test('rejects an invalid PR_HEAD_SHA', async () => {
  await assert.rejects(load({ PR_HEAD_SHA: 'xyz' }), /PR_HEAD_SHA rejected/);
});

test('ensure creates the service once, with autoDeploy off, and comments', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/services') && !u.includes('name=')) return json200({ service: { id: 'srv-new', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } });
    return json200([]); // GET /services?name=... -> no existing service
  });
  const m = await load();
  await m.ensure();
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
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /render-previews-iam/);
  assert.match(comments[0].body.body, /https:\/\/iam-pr3\.onrender\.com/);
});

test('ensure on update triggers exactly one explicit deploy when the origin is unchanged', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://iam-pr3.onrender.com' } }]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load();
  await m.ensure();
  assert.equal(renderCalls(calls, 'POST', /\/v1\/services$/).length, 0, 'no second creation');
  assert.equal(renderCalls(calls, 'POST', /\/services\/srv-old\/deploys/).length, 1, 'exactly one explicit deploy: no double build');
  assert.equal(renderCalls(calls, 'PUT', /env-vars/).length, 0, 'no env update when origin already right');
});

test('ensure on update with a changed URL updates the env var and does NOT also trigger a deploy', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('/env-vars')) return json200([{ envVar: { key: 'IAM_PUBLIC_ORIGIN', value: 'https://old.onrender.com' } }]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3', serviceDetails: { url: 'https://iam-pr3.onrender.com' } } }]);
    return json200({});
  });
  const m = await load();
  await m.ensure();
  assert.equal(renderCalls(calls, 'PUT', /\/services\/srv-old\/env-vars\/IAM_PUBLIC_ORIGIN/).length, 1);
  assert.equal(renderCalls(calls, 'POST', /\/deploys/).length, 0, 'env change redeploys by itself: no second trigger');
});

test('ensure skips cleanly when the branch has no demo/Dockerfile', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return notFound;
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    return json200([]);
  });
  const m = await load();
  await m.ensure();
  assert.equal(renderCalls(calls, 'POST', /\/v1\/services/).length, 0, 'no Render write at all');
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /demo\/Dockerfile/);
});

test('ensure updates an existing marked comment instead of posting a new one', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/contents/demo/Dockerfile')) return json200({ type: 'file' });
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([{ id: 42, body: '<!-- render-previews-iam -->\nold' }]);
    return json200([]);
  });
  const m = await load();
  await m.ensure();
  assert.equal(ghCalls(calls, 'PATCH', /\/issues\/comments\/42/).length, 1);
  assert.equal(ghCalls(calls, 'POST', /\/issues\/3\/comments/).length, 0);
});

test('cleanup deletes the service and comments', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    if (u.includes('name=')) return json200([{ service: { id: 'srv-old', name: 'iam-pr3' } }]);
    return json200({});
  });
  const m = await load({ PR_HEAD_BRANCH: 'closed' });
  await m.cleanup();
  assert.equal(renderCalls(calls, 'DELETE', /\/services\/srv-old/).length, 1);
  const comments = ghCalls(calls, 'POST', /\/issues\/3\/comments/);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body.body, /supprime/);
});

test('cleanup is a no-op on Render when the service does not exist', async () => {
  const calls = mockFetch(async (u) => {
    if (u.includes('api.github.com') && u.includes('/comments')) return json200([]);
    return json200([]);
  });
  const m = await load({ PR_HEAD_BRANCH: 'closed' });
  await m.cleanup();
  assert.equal(renderCalls(calls, 'DELETE', /\/services\//).length, 0);
});
