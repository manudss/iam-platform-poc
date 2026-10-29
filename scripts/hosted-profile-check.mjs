// Hosted check of profile fields, sign-up (simulated confirmation), organizations, roles, concurrency and persistence. FICTIONAL data only.
// The hosted edge adds the admin capability to /api calls, so refusals of admin routes for ordinary accounts are proven by the API tests, not here.
// ONLY_SHOTS=1 skips the API flow (screenshots only: not a full proof). The sign-up endpoint is rate limited to 5 requests per hour per address (shared behind the hosted proxy), the full flow uses 4.
// Usage: NODE_PATH=... CHROME_BIN=... node scripts/hosted-profile-check.mjs https://<service>.onrender.com [outDir]
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const BASE = (process.argv[2] ?? '').replace(/\/$/, ''); if (!BASE) { console.log('usage: hosted-profile-check.mjs <url> [outDir]'); process.exit(1); }
const out = resolve(process.argv[3] ?? join(tmpdir(), 'iam-hosted-profile-shots')); mkdirSync(out, { recursive: true });
const RUN = Date.now().toString(36).slice(-6), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', CH = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const tokenFor = async (username, password) => {
  const a = await (await fetch(BASE + '/core/authorize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'demo-web', redirect_uri: BASE + '/callback', code_challenge: CH, username, password }) })).json();
  assert.ok(a.code, 'sign-in refused for ' + username + ': ' + JSON.stringify(a));
  return (await (await fetch(BASE + '/core/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: a.code, code_verifier: V, client_id: 'demo-web', redirect_uri: BASE + '/callback' }) })).json()).id_token;
};
const mk = (tok) => async (method, path, body, branch) => { const r = await fetch(BASE + '/api/tenants/acme-demo' + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, ...(branch ? { 'x-iam-branch': branch } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const ok = (r, what, st = [200, 201]) => { assert.ok(st.includes(r.s), `${what}: HTTP ${r.s} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
let browser, page; const log = (...a) => console.log(...a);
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(3000); }
  const alice = mk(await tokenFor('demo-alice', 'demo-only-not-a-secret'));
  const newBranch = async (n) => { ok(await alice('POST', '/versioning/branches', { name: n, from: 'main' }, n), 'create branch ' + n); return n; };
  const apply = async (b) => { const w = await alice('GET', '/workspace', undefined, b); const info = await alice('GET', '/versioning/branches', undefined, b); const head = (info.j.branches ?? []).find((x) => x.name === b)?.commit; return alice('POST', '/workspace/apply', { confirm: true, expectedHead: head }, b); };

  if (!process.env.ONLY_SHOTS) {
  // 1. closed by default and nothing live yet
  const b1 = await newBranch('pf-' + RUN);
  assert.equal((await fetch(BASE + '/api/tenants/acme-demo/signup/schema')).status, 404, 'sign-up is closed by default');
  log('1 sign-up closed by default: ok');
  // 2. plugins + configuration staged
  for (const id of ['hr-attributes', 'organizations']) { ok(await alice('POST', `/plugins/${id}/install`, { grants: {} }, b1), 'install ' + id, [200, 201]); ok(await alice('POST', `/plugins/${id}/enable`, { grants: {} }, b1), 'enable ' + id, [200, 201]); }
  ok(await alice('PUT', '/profile-fields', { config: { fields: { 'hr-attributes.job_title': { selfEdit: true, signup: 'required' }, 'hr-attributes.language': { selfEdit: true, signup: 'optional' }, 'hr-attributes.phone': { selfEdit: true } }, signup: { open: true } } }, b1), 'save config');
  const bad = await alice('PUT', '/profile-fields', { config: { fields: { 'hr-attributes.employee_grade': { selfEdit: true } } } }, b1); assert.equal(bad.s, 400, 'authority field refused by the API: ' + JSON.stringify(bad.j));
  assert.equal((await fetch(BASE + '/api/tenants/acme-demo/signup/schema')).status, 404, 'staged config does not open sign-up before Apply');
  ok(await alice('POST', '/roles', { id: 'auditor-' + RUN, label: 'Auditor (demo)' }, b1), 'create role');
  ok(await alice('POST', '/organizations', { id: 'acme-' + RUN, name: 'Acme (demo)' }, b1), 'create org');
  ok(await alice('PUT', '/organizations/memberships/demo-bob', { orgIds: ['acme-' + RUN] }, b1), 'org membership');
  const roles0 = await alice('GET', '/roles', undefined, 'main'); assert.ok(!roles0.j.roles?.some((r) => r.id === 'auditor-' + RUN), 'role is not live before Apply');
  const ap1 = await apply(b1); assert.equal(ap1.j.applied, true, JSON.stringify(ap1.j)); log('2 apply 1: applied', ap1.j.commit);
  // 3. public sign-up -> simulated confirmation -> approval -> sign-in -> limits
  const sch = await fetch(BASE + '/api/tenants/acme-demo/signup/schema'); assert.equal(sch.status, 200); const sj = await sch.json(); assert.ok(sj.fields.some((f) => f.key === 'hr-attributes.job_title' && f.required)); assert.ok(!sj.fields.some((f) => /grade|department|manager/.test(f.key)));
  const uid = 'nora-' + RUN, pw = 'fictional-pass-' + RUN + 'x';
  const su = (b) => fetch(BASE + '/api/tenants/acme-demo/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await su({ id: uid, display_name: 'Nora Demo', email: `${uid}@example.invalid`, password: pw, roles: ['admin'], values: { 'hr-attributes.job_title': 'x' } })).status, 400, 'roles in the body refused');
  assert.equal((await su({ id: uid, display_name: 'Nora Demo', email: `${uid}@example.invalid`, password: pw, values: { 'hr-attributes.employee_grade': 'G9', 'hr-attributes.job_title': 'x' } })).status, 400, 'authority field refused at sign-up');
  const r1 = await su({ id: uid, display_name: 'Nora Demo', email: `${uid}@example.invalid`, password: pw, values: { 'hr-attributes.job_title': 'Tester' } }); assert.ok([200, 201].includes(r1.status), 'sign-up request ' + r1.status);
  const r2 = await su({ id: 'demo-alice', display_name: 'X', email: 'other@example.invalid', password: pw, values: { 'hr-attributes.job_title': 'x' } }); assert.deepEqual(await r2.json(), await r1.json(), 'taken id answers like success');
  const box = ok(await alice('GET', '/auth/outbox'), 'outbox'); assert.equal(box.simulated, true); const mail = box.messages.find((m) => m.to === `${uid}@example.invalid`); assert.ok(mail, 'confirmation is in the SIMULATED outbox (no real mail)');
  const code = /code: (\S+)/.exec(mail.text)[1];
  let reqs = ok(await alice('GET', '/signup/requests'), 'requests').requests; assert.equal(reqs.find((q) => q.id === uid)?.confirmed, false);
  await fetch(BASE + '/api/tenants/acme-demo/signup/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: code }) });
  reqs = ok(await alice('GET', '/signup/requests'), 'requests').requests; assert.equal(reqs.find((q) => q.id === uid)?.confirmed, true);
  const b2 = await newBranch('pf2-' + RUN);
  ok(await alice('POST', `/signup/requests/${uid}/approve`, {}, b2), 'approve'); const ap2 = await apply(b2); assert.equal(ap2.j.applied, true, JSON.stringify(ap2.j)); log('3 sign-up approved and applied');
  const nora = mk(await tokenFor(uid, pw)); log('3 nora (ordinary account) signed in');
  const me = ok(await nora('GET', '/me/profile'), 'nora profile'); assert.equal(me.values['hr-attributes.job_title'], 'Tester'); assert.deepEqual(me.sections.roles ?? [], [], 'no role granted');
  ok(await nora('PATCH', '/me/profile', { values: { 'hr-attributes.language': 'fr', 'hr-attributes.phone': '+33 6 12 34 56 78' } }), 'nora edits own fields');
  assert.equal((await nora('PATCH', '/me/profile', { values: { 'hr-attributes.employee_grade': 'G9' } })).s, 403, 'authority field refused');
  assert.equal((await nora('PATCH', '/me/profile', { values: { 'hr-attributes.language': 'de' } })).s, 400, 'wrong value refused');
  assert.equal((await nora('PATCH', '/me/profile', { values: { 'hr-attributes.language': 'en' }, subject: 'demo-alice' })).s, 400, 'spoofed subject refused');
  const alice2 = ok(await alice('GET', '/users/demo-alice/profile', undefined, 'main'), 'alice profile'); assert.equal(alice2.values['hr-attributes.language'], undefined, "another person's values untouched");
  log('3 self-service and refusals: ok');
  // 4. concurrency on the SAME field/person: admin on a branch, person on main, then Apply = explicit conflict
  const b3 = await newBranch('pf3-' + RUN);
  ok(await alice('PATCH', '/users/demo-bob/profile', { values: { 'hr-attributes.job_title': 'Lead (admin)' } }, b3), 'admin edit on branch');
  const bob = mk(await tokenFor('demo-bob', 'demo-only-not-a-secret'));
  ok(await bob('PATCH', '/me/profile', { values: { 'hr-attributes.job_title': 'Manager (bob)' } }), 'bob self edit on main');
  const ap3 = await apply(b3); assert.notEqual(ap3.j.applied, true, 'must not apply silently'); assert.ok(ap3.s >= 400 && /conflict/i.test(JSON.stringify(ap3.j)), 'explicit conflict: ' + ap3.s + JSON.stringify(ap3.j).slice(0, 300));
  const bobNow = ok(await bob('GET', '/me/profile'), 'bob'); assert.equal(bobNow.values['hr-attributes.job_title'], 'Manager (bob)', 'main keeps the person value');
  log('4 concurrent same-field edit: explicit conflict, nothing lost');
  // 5. persistence check + close sign-up
  const b4 = await newBranch('pf4-' + RUN);
  ok(await alice('PUT', '/profile-fields', { config: { fields: { 'hr-attributes.job_title': { selfEdit: true, signup: 'required' }, 'hr-attributes.language': { selfEdit: true, signup: 'optional' }, 'hr-attributes.phone': { selfEdit: true } }, signup: { open: false } } }, b4), 'close config');
  const ap4 = await apply(b4); assert.equal(ap4.j.applied, true, JSON.stringify(ap4.j));
  assert.equal((await fetch(BASE + '/api/tenants/acme-demo/signup/schema')).status, 404, 'sign-up closed again');
  assert.equal((await su({ id: 'late-' + RUN, display_name: 'L', email: 'l@example.invalid', password: pw, values: { 'hr-attributes.job_title': 'x' } })).status, 404);
  const live = ok(await alice('GET', '/roles', undefined, 'main'), 'roles live'); assert.ok(live.roles.some((r) => r.id === 'auditor-' + RUN), 'role persisted after Apply'); assert.equal(live.roles.find((r) => r.id === 'auditor-' + RUN).assigned, 0, 'a new role is assigned to nobody and grants nothing');
  const orgs = ok(await alice('GET', '/organizations', undefined, 'main'), 'orgs'); assert.ok(orgs.members.some((m) => m.subject === 'demo-bob'));
  log('5 sign-up closed again; role and org persisted');

  }
  // 6. screenshots (desktop + mobile), signed in as demo-alice in the console
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => d.accept());
  const shot = (n) => page.screenshot({ path: join(out, n + '.png'), fullPage: false });
  await page.goto(BASE + '/signup'); await page.waitForSelector('#su-closed'); await sleep(1500); await shot('1-signup-closed-desktop');
  await page.goto(`${BASE}/login`); await page.waitForSelector('#signin-browser'); await Promise.all([page.waitForURL(/\/core\/authorize/), page.click('#signin-browser')]);
  await page.waitForSelector('input[name=username]'); await page.fill('input[name=username]', 'demo-alice'); await page.fill('input[name=password]', 'demo-only-not-a-secret'); await page.click('button[type=submit]');
  await page.waitForSelector('[name=globalBranch]');
  const b5 = 'pf5-' + RUN; await page.fill('[name=workspaceNewBranch]', b5); await page.getByRole('button', { name: 'Create & select', exact: true }).click(); await page.waitForFunction((n) => document.body.innerText.includes(n), b5);
  for (const [nav, sel, name] of [['/profile-fields', '#pf-table', '2-profile-fields'], ['/organizations', '#org-table', '3-organizations'], ['/roles', '#role-table', '4-roles'], ['/my-profile', '#mp-form', '5-my-profile'], ['/users', '#users-table', '6-users']]) {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.locator(`nav a[data-nav="${nav}"]`).click(); await page.waitForSelector(sel); await page.waitForLoadState('networkidle'); await page.waitForFunction(() => !document.querySelector('main').innerText.includes('Loading...')); await sleep(2500);
    assert.equal(await page.locator('[role=alert]').count(), 0, nav + ': no alert (' + (await page.locator('[role=alert]').allInnerTexts()).join('|') + ')');
    await page.setViewportSize({ width: 1280, height: 900 }); await shot(name + '-desktop'); await page.setViewportSize({ width: 390, height: 800 }); await shot(name + '-mobile');
  }
  assert.equal(errs.length, 0, 'page errors: ' + errs.join('|'));
  log('6 screenshots in', out, 'HOSTED PROFILE CHECK PASS');
} catch (e) { console.error('FAILED:', e.message.split('\n')[0]); try { console.error('PAGE:', page.url(), (await page.innerText('main')).slice(0, 600)); } catch {} process.exitCode = 1; } finally { await browser?.close(); }
