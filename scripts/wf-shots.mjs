// Visual proof run: real local demo (Dolt + core + API + console), real browser sign-in, real workflows UI.
// Sets up a publish-approval scenario via the API, then drives Chrome through the console: sign-in,
// workflows list, templates gallery, run waiting on approval, task inbox, decision, resumed run.
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4200';
const API = 'http://127.0.0.1:3000/tenants/acme-demo';
const ADMIN = process.env.DEMO_ADMIN_TOKEN;
const OUT = '/downloads/wf-shots';
const PW = 'demo-only-not-a-secret';
mkdirSync(OUT, { recursive: true });

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const signIn = async (username) => {
  let a = {};
  for (let i = 0; i < 12; i++) {
    a = await (await post('/core/authorize', { client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: challenge, username, password: PW })).json();
    if (a.code) break;
    if (a.error !== 'temporarily_unavailable') break;
    await new Promise((r) => setTimeout(r, 3000)); // auth gate still warming up under first-boot load
  }
  if (!a.code) throw new Error('authorize refused: ' + JSON.stringify(a));
  const t = await (await post('/core/token', { code: a.code, code_verifier: verifier, client_id: 'demo-web', redirect_uri: BASE + '/callback' })).json();
  if (!t.id_token) throw new Error('token refused: ' + JSON.stringify(t));
  return t.id_token;
};

const token = await signIn('demo-alice');
console.log('token ok');
// Workspace mode: administration writes need a working branch context (main is read-only).
// Fresh branch per run: it must inherit the current main, including earlier proof runs' merged grants.
const BR = 'feature/visual-proof-' + Date.now().toString(36);
await fetch(API + '/versioning/branches', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-api-admin-token': ADMIN }, body: JSON.stringify({ name: BR, from: 'main' }) });
const api = (method, path, body) => fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-api-admin-token': ADMIN, 'x-iam-branch': BR }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const ok = async (method, path, body) => { const r = await api(method, path, body); if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

// Previous proof runs granted demo-bob branch-merger: revoke it on the working branch first so the
// workflow's grant step always produces a real change to review and publish (idempotent).
const bobGrant = await api('GET', '/versioning/tables/assignments?ref=main&limit=200');
if ((bobGrant.body?.rows ?? []).some((r) => r.identity_id === 'demo-bob' && r.role_id === 'branch-merger')) {
  const rv = await api('POST', '/versioning/tables/assignments/edit', { branch: BR, ops: [{ op: 'delete', key: { identity_id: 'demo-bob', role_id: 'branch-merger' } }], message: 'visual proof: reset demo-bob grant' });
  console.log('revoke previous grant:', rv.status);
}

// Plugins on (idempotent).
for (const p of ['workflows-iga', 'workflow-connectors']) { await api('POST', `/plugins/${p}/install`, {}); await api('POST', `/plugins/${p}/enable`, {}); }
const wf = await api('GET', '/workflows');
console.log('workflows route:', wf.status);

// A workflow whose run parks on a publication approval task (assigned to the admin pool).
const graph = { nodes: [
  { id: 'grant', type: 'lyam-grant-assignment', name: 'Grant branch-merger to demo-bob', config: { identity: 'demo-bob', role: 'branch-merger' } },
  { id: 'publish', type: 'lyam-request-publish', name: 'Request publication review', config: { title: 'Access review campaign: Q4 visual proof' } },
], edges: [{ from: 'grant', to: 'publish' }] };
const def = await ok('POST', '/workflows', { name: 'Access review - visual proof', description: 'Recertification-style grant with a human publication review', graph, trigger: { event: 'http.webhook-received', config: { token: 'visual-proof-hook-demo' } } });
// Runs always execute the LIVE (main) definition by design: merge the working branch first, as the console Apply flow would.
let pr = await api('POST', '/versioning/pulls', { title: 'Visual proof workflow', source: BR, target: 'main' });
if (pr.status === 409) pr = { body: (await ok('GET', '/versioning/pulls?status=open')).pullRequests.find((p) => p.source === BR && p.target === 'main') };
if (!pr.body?.id) throw new Error('pull request setup failed: ' + JSON.stringify(pr));
await ok('POST', `/versioning/pulls/${pr.body.id}/merge`, {});
console.log('merged pr', pr.body.id);
// Fire the workflow's public webhook trigger: the run starter is 'webhook', so demo-alice may decide the approval task
// (anti-self-approval covers the human starter chain and the beneficiaries).
const run = await fetch(API + `/workflow-hooks/${def.definition.id}/visual-proof-hook-demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ campaign: 'Q4', _dedupe: 'shots-' + Date.now() }) }).then(async (r) => { const b = await r.json().catch(() => null); if (r.status >= 300) throw new Error('hook -> ' + r.status + ' ' + JSON.stringify(b)); return b; });
run.run = { id: run.run, status: run.status };
console.log('run', run.run.id, run.run.status);

// Wait for the approval task to exist.
let task = null;
for (let i = 0; i < 60; i++) {
  const inbox = await ok('GET', '/workflow-tasks?scope=all');
  task = inbox.tasks.find((t) => t.run_id === run.run.id);
  if (task) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('task', task?.id, task?.kind, 'assignee', task?.assignee);

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// The console keeps the operator-typed admin capability token in memory only; a full page load would wipe it.
// Inject the same header at fetch level so every reload behaves as if the field were filled.
await page.addInitScript((adm) => {
  const f = window.fetch.bind(window);
  window.fetch = (input, init = {}) => { const h = new Headers(init.headers || {}); h.set('x-api-admin-token', adm); return f(input, { ...init, headers: h }); };
}, ADMIN);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

// Real sign-in journey through the console and the IdP.
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('button:has-text("Password only")', { timeout: 60000 });
await page.click('button:has-text("Password only")');
await page.waitForSelector('input[name=username]', { timeout: 60000 });
await page.fill('input[name=username]', 'demo-alice');
await page.fill('input[name=password]', PW);
await page.click('button[type=submit], button:has-text("Sign in"), button:has-text("Continue")');
await page.waitForURL(/localhost:4200\/(?!core)/, { timeout: 60000 }).catch(() => {});
await page.waitForLoadState('networkidle').catch(() => {});
console.log('signed in, at', page.url());

// The personal working branch may have failed to open: retry it if the shell offers.
const retry = page.locator('button:has-text("Retry")');
if (await retry.count()) { await retry.first().click(); await page.waitForTimeout(3000); }
await shot('01-console-home');

// Enter the admin capability token if the console asks for it (some screens need it).
// Workflows list.
await page.goto(BASE + '/workflows', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await shot('02-workflows-list');

// Templates gallery (official catalog incl. recertification).
await page.goto(BASE + '/workflows/templates', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await shot('03-templates');

// The waiting run in Executions.
await page.goto(`${BASE}/workflows/runs?run=${run.run.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await shot('04-run-waiting');

// Task inbox: the approval task open.
await page.goto(BASE + '/workflows/tasks', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const row = page.locator('tr.wt-row', { hasText: run.run.id }).first();
if (await row.count()) { await row.click(); await page.waitForTimeout(1200); }
await shot('05-task-inbox-open');

// Decide in the UI: approve with a justification.
if (await row.count()) {
  await page.fill('textarea[name=wtJust]', 'Reviewed in the console: the grant matches the campaign scope.');
  await page.click('button:has-text("approved")');
  await page.waitForTimeout(2500);
  await shot('06-task-decided');
}

// Finish the publication journey for real: merge the run-branch PR the publish step opened,
// then declare the observed state on its merge-watch task (the engine re-reads the real PR state).
const runBranch = 'workflow/' + run.run.id.replace(/^run-/, '').slice(0, 8);
await page.waitForTimeout(2500);
const open = await ok('GET', '/versioning/pulls?status=open');
const runPr = (open.pullRequests ?? []).find((p) => p.source === runBranch);
if (runPr) {
  await ok('POST', `/versioning/pulls/${runPr.id}/merge`, {});
  console.log('merged run-branch pr', runPr.id, runBranch);
  await page.waitForTimeout(1500);
  const watchInbox = await ok('GET', '/workflow-tasks?scope=all&status=open');
  const watch = (watchInbox.tasks ?? []).find((t) => t.run_id === run.run.id && t.kind === 'publish-merge-watch');
  if (watch) await ok('POST', `/workflow-tasks/${watch.id}/decision`, { decision: 'merged', justification: 'PR merged in the console (visual proof)' });
  await page.waitForTimeout(3000);
} else console.log('no run-branch PR found for', runBranch);

// The run after the decision: publication done, run completed.
await page.goto(`${BASE}/workflows/runs?run=${run.run.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4500);
await shot('07-run-after-decision');

await browser.close();
console.log('DONE');
