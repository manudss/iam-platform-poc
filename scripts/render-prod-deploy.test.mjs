// Unit tests for scripts/render-prod-deploy.mjs with a mocked global fetch (no network,
// no secrets). Run: node --test scripts/render-prod-deploy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

let importCounter = 0;
const BASE_ENV = { RENDER_API_KEY: 'test-key', PROD_POLL_MS: '1' };

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
const gitBackedSvc = json200([{ service: { id: 'srv-1', name: 'iam-poc', serviceDetails: { runtime: 'docker' } } }]);
const imageBackedSvc = json200([{ service: { id: 'srv-1', name: 'iam-poc', serviceDetails: { runtime: 'image' }, image: { imagePath: 'ghcr.io/manudss/iam-platform-poc:latest' } } }]);
const liveDeploy = () => json200([{ deploy: { id: 'dep-1', status: 'live', createdAt: new Date().toISOString() } }]);

async function load(env = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('RENDER_') || k.startsWith('PROD_') || k === 'DRY_RUN') delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  // Exercise dormant delivery logic only in an in-memory mutant, never weaken the shipped guard.
  const source=readFileSync(new URL('./render-prod-deploy.mjs',import.meta.url),'utf8').replace('CLOSED_RECOVERY_DEPLOY_SUSPENDED = true','CLOSED_RECOVERY_DEPLOY_SUSPENDED = false');
  return import('data:text/javascript;base64,'+Buffer.from(source+'\n// case '+importCounter++).toString('base64'));
}
const deploys = (calls) => calls.filter((c) => c.method === 'POST' && /\/deploys$/.test(c.url));

test('git-backed service: skip, never triggers a deploy (no Render build)', async () => {
  const calls = mockFetch(async () => gitBackedSvc);
  const m = await load();
  const r = await m.run();
  assert.equal(r.deployed, false);
  assert.equal(r.reason, 'git-backed');
  assert.equal(deploys(calls).length, 0, 'no deploy POST');
});

test('image-backed service: deploys and watches to live', async () => {
  const calls = mockFetch(async (u, opts) => {
    if (u.includes('/deploys') && opts.method === 'POST') return json200({ deploy: { id: 'dep-1' } });
    if (u.includes('/deploys')) return liveDeploy();
    return imageBackedSvc;
  });
  const m = await load();
  const r = await m.run();
  assert.equal(r.deployed, true);
  assert.equal(deploys(calls).length, 1, 'exactly one deploy POST');
});

test('unknown service: throws', async () => {
  mockFetch(async () => json200([]));
  const m = await load();
  await assert.rejects(m.run(), /introuvable/);
});

test('failed deploy: rejects (Actions run must go red)', async () => {
  mockFetch(async (u, opts) => {
    if (u.includes('/deploys') && opts.method === 'POST') return json200({ deploy: { id: 'dep-1' } });
    if (u.includes('/deploys')) return json200([{ deploy: { id: 'dep-1', status: 'update_failed', createdAt: new Date().toISOString() } }]);
    return imageBackedSvc;
  });
  const m = await load();
  await assert.rejects(m.run(), /a echoue/);
});

test('name filter: iam-poc-demo-2 is not iam-poc', async () => {
  mockFetch(async () => json200([{ service: { id: 'srv-9', name: 'iam-poc-demo-2', serviceDetails: { runtime: 'image' } } }]));
  const m = await load();
  await assert.rejects(m.run(), /introuvable/);
});

test('DRY_RUN: prints the plan, no network', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return json200({}); };
  const m = await load({ DRY_RUN: '1' });
  const r = await m.run();
  assert.equal(called, 0, 'no fetch in DRY_RUN');
  assert.equal(r.deployed, true);
});

test('missing RENDER_API_KEY (not dry): throws on attempted resume', async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith('RENDER_') || k.startsWith('PROD_') || k === 'DRY_RUN') delete process.env[k];
  const m=await load({RENDER_API_KEY:''});
  await assert.rejects(m.run(),/RENDER_API_KEY missing/);
});

test('shipped closed-recovery suspension cannot contact Render, even with key and DRY_RUN',async()=>{
 for(const dry of ['0','1']){
  Object.assign(process.env,BASE_ENV,{DRY_RUN:dry});
  const calls=mockFetch(()=>{throw Error('network must not be called')});
  const m=await import(`./render-prod-deploy.mjs?closed=${dry}`);
  assert.equal(m.CLOSED_RECOVERY_DEPLOY_SUSPENDED,true);
  assert.deepEqual(await m.run(),{deployed:false,reason:'closed-recovery-suspended'});
  assert.equal(calls.length,0);
 }
 const yaml=readFileSync(new URL('../.github/workflows/demo-deploy.yml',import.meta.url),'utf8');
 assert.match(yaml,/if: \$\{\{ false \}\}/);
});

test('closed recovery never publishes latest and removes the temporary secret reader job',()=>{
 const image=readFileSync(new URL('../.github/workflows/demo-image.yml',import.meta.url),'utf8');
 assert.doesNotMatch(image,/TAGS=.*:latest/);
 assert.match(image,/TAGS="ghcr\.io\/\$\{REPO\}:\$\{SHA\}"/);
 const ci=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
 assert.doesNotMatch(ci,/^  render_state:/m);assert.doesNotMatch(ci,/RENDER_API_KEY/);
});
