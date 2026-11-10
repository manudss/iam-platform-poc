// The API guard for screen access: the route -> screen map, the policy answer, the capability that stays required and the fallbacks. The Cedar rules themselves
// are proven against the real core in activation.e2e.spec.ts; here the core is a small fake that answers from a role table.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard.js';
import { screensFor } from './screens.js';

const TOKEN = 'test-admin-token-0123456789';
const roles: Record<string, string[]> = { alice: ['iam-admin'], lucie: ['manager'], noemie: ['main-merger'], noah: ['org-admin'], bob: [] };
const opens = (r: string[], screen: string) => r.includes('iam-admin') || screen === 'my-profile'
  || (['manager', 'org-admin'].some((x) => r.includes(x)) && ['users', 'profile-reviews', 'assignments'].includes(screen))
  || (r.includes('main-merger') && ['dolt-pulls', 'dolt-compare', 'dolt-history', 'dolt-branches'].includes(screen));

describe('screen access guard', () => {
  let core: Server, active = true, down = false;
  before(async () => {
    core = createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const j = JSON.parse(b); const sub = /"(.*)"/.exec(j.principal)![1]; const screen = /"(.*)"/.exec(j.resource)![1];
        res.setHeader('content-type', 'application/json');
        if (!active) return void res.end(JSON.stringify({ allow: false, reasons: ['no-active-version'], errors: [] }));
        res.end(JSON.stringify({ allow: opens(roles[sub] ?? [], screen), reasons: [], errors: [] }));
      });
    });
    await new Promise<void>((r) => core.listen(13591, '127.0.0.1', r));
    process.env.IAM_API_ADMIN_TOKEN = TOKEN; process.env.IAM_CORE_URL = 'http://127.0.0.1:13591'; process.env.IAM_SCREEN_ACCESS = '1';
    process.env.IAM_API_ADMIN_SUBJECTS = 'alice';
  });
  after(() => { core.close(); for (const k of ['IAM_CORE_URL', 'IAM_SCREEN_ACCESS', 'IAM_API_ADMIN_SUBJECTS']) delete process.env[k]; });
  const ctx = (sub: string | null, method: string, path: string, token: string | null = TOKEN) => ({ switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: `/tenants/acme-demo/${path}`, headers: token ? { 'x-api-admin-token': token } : {}, user: sub ? { sub } : undefined }) }) }) as never;
  const can = async (sub: string | null, method: string, path: string, token?: string | null) => { try { return await new AdminGuard().canActivate(ctx(sub, method, path, token)); } catch (e) { assert.ok(e instanceof ForbiddenException, String(e)); return false; } };

  it('maps each route to its screens (Dolt explorer areas included)', () => {
    assert.deepEqual(screensFor('GET', 'users'), ['users']); assert.deepEqual(screensFor('POST', 'profile-reviews/x/accept'), ['profile-reviews']);
    assert.deepEqual(screensFor('POST', 'versioning/sql'), ['dolt-sql']); assert.deepEqual(screensFor('POST', 'versioning/tables/roles/edit'), ['dolt-edit']);
    assert.deepEqual(screensFor('GET', 'versioning/tables/roles?ref=main'), ['dolt-data']); assert.deepEqual(screensFor('POST', 'versioning/pulls/3/merge'), ['dolt-pulls', 'dolt-home']);
    assert.deepEqual(screensFor('PUT', 'versioning/branches/x/protection'), ['dolt-branches']); assert.deepEqual(screensFor('GET', 'something-new'), []);
  });
  it('the policy decides: lucie opens the people screens only, noemie the merge screens only, nobody but alice the rest', async () => {
    assert.equal(await can('lucie', 'GET', 'users'), true); assert.equal(await can('lucie', 'POST', 'profile-reviews/a/accept'), true); assert.equal(await can('lucie', 'POST', 'workspace/apply'), true);
    for (const [m, p] of [['PUT', 'roles/x'], ['GET', 'policies/rules'], ['POST', 'activations'], ['POST', 'versioning/sql'], ['GET', 'versioning/tables/roles'], ['GET', 'versioning/pulls'], ['PUT', 'plugins/x/settings']]) assert.equal(await can('lucie', m, p), false, `lucie ${m} ${p}`);
    assert.equal(await can('lucie', 'GET', 'roles'), true, 'the assignments screen reads the role catalogue'); assert.equal(await can('lucie', 'GET', 'versioning/diff/assignments'), true); assert.equal(await can('lucie', 'GET', 'versioning/diff/identities'), false, 'only the assignments diff is readable');
    for (const [m, p] of [['GET', 'versioning/pulls'], ['POST', 'versioning/pulls/1/merge'], ['GET', 'versioning/diff?from=a&to=b'], ['GET', 'versioning/log'], ['POST', 'versioning/branches'], ['DELETE', 'versioning/branches/x'], ['PUT', 'versioning/branches/x/protection']]) assert.equal(await can('noemie', m, p), true, `noemie ${m} ${p}`);
    for (const [m, p] of [['GET', 'versioning/tables/roles'], ['POST', 'versioning/tables/roles/edit'], ['POST', 'versioning/sql'], ['GET', 'users'], ['GET', 'roles'], ['POST', 'activations'], ['GET', 'plugins']]) assert.equal(await can('noemie', m, p), false, `noemie ${m} ${p}`);
    assert.equal(await can('noah', 'GET', 'users'), true); assert.equal(await can('noah', 'GET', 'versioning/pulls'), false); assert.equal(await can('bob', 'GET', 'users'), false);
    for (const [m, p] of [['GET', 'roles'], ['POST', 'versioning/sql'], ['POST', 'activations'], ['GET', 'something-new'], ['GET', 'users']]) assert.equal(await can('alice', m, p), true, `alice ${m} ${p}`);
    assert.equal(await can('lucie', 'GET', 'something-new'), false, 'an unmapped route is for the super admin only');
  });
  it('the edge capability stays required, and a signed-in subject too', async () => {
    assert.equal(await can('alice', 'GET', 'users', null), false); assert.equal(await can('alice', 'GET', 'users', 'wrong-token-0123456789'), false); assert.equal(await can(null, 'GET', 'users'), false);
  });
  it('the refusal names the screen and how to get access', async () => {
    try { await new AdminGuard().canActivate(ctx('lucie', 'POST', 'versioning/sql')); assert.fail('refused expected'); } catch (e) { assert.match(JSON.stringify((e as ForbiddenException).getResponse()), /do not have access to dolt-sql/); }
  });
  it('before the first activation the legacy subject list decides; an unreachable engine refuses', async () => {
    active = false; assert.equal(await can('alice', 'GET', 'users'), true); assert.equal(await can('lucie', 'GET', 'users'), false, 'not on the legacy list');
    active = true; core.close(); down = true; await new Promise((r) => setTimeout(r, 50)); process.env.IAM_CORE_URL = 'http://127.0.0.1:1'; assert.equal(await can('alice', 'GET', 'users'), false);
    assert.equal(down, true);
  });
  it('switched off (default), the legacy capability and subject list decide as before', async () => {
    process.env.IAM_CORE_URL = 'http://127.0.0.1:13591'; delete process.env.IAM_SCREEN_ACCESS;
    assert.equal(await can('lucie', 'GET', 'users'), false); assert.equal(await can('alice', 'GET', 'roles'), true);
  });
});
