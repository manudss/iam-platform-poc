import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowReads } from './reads.js';

/**
 * Point 6 of the review: the workflow business reads must be provably tenant-bound and must never
 * select more columns than the explicit projection (a SELECT * on identities would silently leak any
 * PII column a schema adds later). These tests capture every SQL statement the service emits through a
 * fake connection and assert the shape of the queries themselves - not just the AuthGuard in front.
 */

type Captured = { sql: string; params: unknown[] };

const IDENTITY_BASE_COLS = ['id', 'display_name', 'department', 'manager_id'];

const fakeConn = (captured: Captured[], identityCols: string[] = IDENTITY_BASE_COLS) => ({
  query: async (sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    captured.push({ sql, params });
    const q = sql.toLowerCase();
    if (q.includes('information_schema.columns')) return [identityCols.map((column_name) => ({ column_name })), []];
    if (q.includes('information_schema.tables')) return [[{ n: 1 }], []];
    if (q.startsWith('select count(*)')) return [[{ n: 1 }], []];
    if (q.includes('from identities where id =')) return [[{ id: 'demo-bob', display_name: 'Bob', department: 'finance', manager_id: null, email: 'bob@example.invalid', login_enabled: 1 }], []];
    if (q.includes('from identities')) return [[{ id: 'demo-bob', display_name: 'Bob', department: 'finance', manager_id: null }], []];
    if (q.includes('from assignments where identity_id =')) return [[{ role_id: 'payment-creator' }], []];
    if (q.includes('from assignments')) return [[{ identity_id: 'demo-bob', role_id: 'payment-creator' }], []];
    if (q.includes('from roles')) return [[{ id: 'payment-creator', label: 'Payment creator', is_sensitive: 1, assigned: 1 }], []];
    if (q.includes('from sod_rules')) return [[{ role_a: 'payment-creator', role_b: 'payment-approver' }], []];
    if (q.includes('from profile_field_values')) return [[{ field_key: 'badge', value: '"blue"' }], []];
    if (q.includes('from organizations')) return [[{ id: 'org-1', name: 'Org', parent_id: null }], []];
    if (q.includes('from org_memberships')) return [[{ subject: 'demo-bob', org_id: 'org-1' }], []];
    if (q.includes('from app_connectors')) return [[{ id: 'app-1', name: 'App', description: '', protocol: 'oidc', enabled: 1, config: '{}' }], []];
    if (q.includes('from plugin_settings')) return [[], []];
    return [[], []];
  },
});

const svcWith = (captured: Captured[], identityCols?: string[]) => {
  const conn = fakeConn(captured, identityCols);
  const versioning = { at: (_ref: string, fn: (c: typeof conn) => Promise<unknown>) => fn(conn) };
  return new WorkflowReads(versioning as never);
};

const TENANT_TABLES = ['profile_field_values', 'organizations', 'org_memberships', 'app_connectors', 'plugin_settings'];

describe('WorkflowReads: explicit projections and tenant isolation (query-shape proof)', () => {
  it('no business read ever emits SELECT *: every projection is an explicit column list', async () => {
    const captured: Captured[] = [];
    const s = svcWith(captured);
    await s.readUser('acme', 'main', 'demo-bob');
    await s.listUsers('acme', 'main', { query: 'bob' });
    await s.listRoles('main');
    await s.listAssignments('main', { identity: 'demo-bob' });
    await s.simulateAssignments('main', [{ identity: 'demo-bob', role: 'payment-creator' }], []);
    await s.listOrganizations('acme', 'main');
    await s.listApplications('acme', 'main');
    await s.profileSchema('acme', 'main');
    assert.ok(captured.length >= 12, `expected the full read surface to be exercised, got ${captured.length} statements`);
    for (const { sql } of captured) {
      if (sql.toLowerCase().includes('information_schema')) continue; // schema probes are not business reads
      assert.ok(!/select\s+\*/i.test(sql), `SELECT * in business read: ${sql}`);
    }
  });

  it('identity reads select only the known columns, plus optional ones the schema probe actually saw', async () => {
    const captured: Captured[] = [];
    const s = svcWith(captured); // schema WITHOUT email/login_enabled (the demo shape)
    const u = await s.readUser('acme', 'main', 'demo-bob');
    const identitySelects = captured.filter((c) => c.sql.includes('from identities')).map((c) => c.sql);
    for (const sql of identitySelects) {
      assert.ok(!sql.includes('email'), `email selected though the schema probe did not report it: ${sql}`);
      assert.ok(!sql.includes('login_enabled'), `login_enabled selected though unreported: ${sql}`);
      assert.ok(/select id, display_name, department, manager_id(, [a-z_, ]+)? from identities/.test(sql), `unexpected projection: ${sql}`);
    }
    assert.equal(u.email, null, 'no email column on this schema: null, never an error or a leak');

    const captured2: Captured[] = [];
    const s2 = svcWith(captured2, [...IDENTITY_BASE_COLS, 'email', 'login_enabled']);
    const u2 = await s2.readUser('acme', 'main', 'demo-bob');
    assert.equal(u2.email, 'bob@example.invalid', 'a schema that HAS the column exposes it through the explicit projection');
    const sel2 = captured2.filter((c) => c.sql.includes('from identities')).map((c) => c.sql);
    assert.ok(sel2.every((sql) => sql.includes(', email, login_enabled')), 'optional columns selected explicitly when present');
  });

  it('every query on a tenant-scoped table is bound with tenant = ? carrying the exact tenant', async () => {
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const captured: Captured[] = [];
      const s = svcWith(captured);
      await s.readUser(tenant, 'main', 'demo-bob');
      await s.listOrganizations(tenant, 'main');
      await s.listApplications(tenant, 'main');
      await s.profileSchema(tenant, 'main');
      const scoped = captured.filter((c) => TENANT_TABLES.some((t) => c.sql.includes(`from ${t}`)));
      assert.ok(scoped.length >= 5, `${tenant}: every tenant table read exercised (${scoped.length})`);
      for (const { sql, params } of scoped) {
        assert.ok(/tenant = \?/.test(sql), `${tenant}: unscoped read on a tenant table: ${sql}`);
        assert.ok(params.includes(tenant), `${tenant}: the bound tenant parameter is missing from ${sql} (params ${JSON.stringify(params)})`);
        assert.ok(!params.includes(tenant === 'tenant-a' ? 'tenant-b' : 'tenant-a'), 'never the other tenant');
      }
    }
  });

  it('two tenants never share rows: the same reads with another tenant bind the other tenant id', async () => {
    const capA: Captured[] = [], capB: Captured[] = [];
    await svcWith(capA).listOrganizations('tenant-a', 'main');
    await svcWith(capB).listOrganizations('tenant-b', 'main');
    const orgA = capA.find((c) => c.sql.includes('from organizations'))!;
    const orgB = capB.find((c) => c.sql.includes('from organizations'))!;
    assert.deepEqual(orgA.params, ['tenant-a']);
    assert.deepEqual(orgB.params, ['tenant-b']);
  });

  it('LIKE filters escape wildcards: a user query cannot widen a search with % or _', async () => {
    const captured: Captured[] = [];
    await svcWith(captured).listUsers('acme', 'main', { query: '100%_match' });
    const like = captured.find((c) => c.sql.includes('from identities where'));
    assert.ok(like!.params.includes('%100\\%\\_match%'), `wildcards escaped, got ${JSON.stringify(like!.params)}`);
  });
});
