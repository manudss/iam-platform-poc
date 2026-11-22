import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock, type WfBlockCtx } from './model.js';

const mk = (over: Partial<WfBlockCtx>) => { const lines: string[] = []; return { c: { tenant: 'acme', config: {}, settings: {}, dryRun: false, log: (l: string) => lines.push(l), outputs: {}, branchWrite: async () => undefined, runId: 'run-1', baseBranch: 'main', ...over } as WfBlockCtx, lines }; };

/** In-memory durable-task service shaped like WorkflowTasksService (request/check/inbox/decide). */
const fakeTasks = () => {
  const tasks = new Map<string, Record<string, unknown>>();
  let n = 0;
  return {
    tasks,
    approve: (id: string, by = 'boss') => { const t = tasks.get(id)!; t.status = 'decided'; t.decision = 'approved'; t.decided_by = by; t.justification = null; return t; },
    request: async (a: Record<string, unknown>) => { const t = { id: `task-${++n}`, status: 'open', ...a }; tasks.set(t.id, t); return t; },
    check: async (_tenant: string, id: string) => ({ state: 'decided', task: tasks.get(id) }),
    inbox: async () => ({ tasks: [...tasks.values()] }),
    decide: async () => { throw new Error('not used'); },
  };
};

/** An in-memory branchWrite capturing the SQL statements, mysql2-shaped ([rows] results). */
const fakeDb = (plan: Record<string, unknown>[] = []) => {
  const queries: string[] = [];
  const db = {
    query: async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      const planned = plan.find((p) => sql.includes(String(p.match)));
      return planned ? planned.result : [[]];
    },
  };
  return { queries, db, branchWrite: async (fn: (db: never) => Promise<unknown>, _msg?: string) => fn(db as never) };
};

const run1 = async (t: string, c: never): Promise<Record<string, unknown>> => (await externalBlock(t)!.run(c)) as Record<string, unknown>;

const ORGS = { orgs: [{ id: 'o1', name: 'Root', parent: null }, { id: 'o1a', name: 'Child', parent: 'o1' }, { id: 'o2', name: 'Leaf', parent: null }], members: [{ subject: 'u1', org: 'o2' }, { subject: 'u2', org: 'o2' }] };

describe('completion: organizations (impact control at proposal AND apply time)', () => {
  it('lyam-org-impact shows members, children and the removability', async () => {
    const { c } = mk({ reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o2' } });
    const out = await run1('lyam-org-impact', c as never);
    assert.deepEqual({ members: out.memberCount, children: out.childCount, removable: out.removable }, { members: 2, children: 0, removable: true });
    const { c: c2 } = mk({ reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o1' } });
    assert.equal((await run1('lyam-org-impact', c2 as never)).removable, false);
    await assert.rejects(run1('lyam-org-impact', mk({ reads: { listOrganizations: async () => ORGS } as never, config: { id: 'nope' } }).c as never), /unknown organization/);
  });

  it('lyam-remove-org-member removes the membership and is idempotent when already absent', async () => {
    const f = fakeDb([{ match: 'delete from org_memberships', result: [{ affectedRows: 1 }] }]);
    const { c } = mk({ branchWrite: f.branchWrite as never, config: { subject: 'u1', org: 'o2' } });
    assert.equal((await run1('lyam-remove-org-member', c as never)).removed, true);
    const f2 = fakeDb([{ match: 'delete from org_memberships', result: [{ affectedRows: 0 }] }]);
    assert.equal((await run1('lyam-remove-org-member', mk({ branchWrite: f2.branchWrite as never, config: { subject: 'u1', org: 'o2' } }).c as never)).removed, false);
  });

  it('lyam-propose-org-removal refuses children at proposal time, shows the impact, suspends', async () => {
    const svc = fakeTasks();
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o1', reason: 'cleanup' } }).c as never), /child organization/);
    assert.equal(svc.tasks.size, 0);
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o2', reason: 'cleanup' } }).c as never), /waiting for org-removal/);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.kind, 'org-removal');
    assert.equal((t.detail as { impact: { memberCount: number } }).impact.memberCount, 2);
    assert.equal(t.preventSelfApproval, true);
  });

  it('lyam-propose-org-removal re-reads the references at apply time and refuses a stale approval', async () => {
    const svc = fakeTasks();
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o2', reason: 'cleanup' } }).c as never), /waiting/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    // The references changed since the approval: a new member arrived.
    const changed = { orgs: ORGS.orgs, members: [...ORGS.members, { subject: 'u3', org: 'o2' }] };
    const f = fakeDb();
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => changed } as never, branchWrite: f.branchWrite as never, config: { id: 'o2', reason: 'cleanup' }, resumeWait: { taskId: t.id } as never }).c as never), /changed since the approval/);
    assert.equal(f.queries.some((q) => q.startsWith('delete from organizations')), false);
  });

  it('lyam-propose-org-removal removes on the run branch when the impact is unchanged; an absent org is reported, not an error', async () => {
    const svc = fakeTasks();
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o2', reason: 'cleanup' } }).c as never), /waiting/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    const f = fakeDb([{ match: 'delete from organizations', result: [{ affectedRows: 1 }] }]);
    const out = await run1('lyam-propose-org-removal', mk({ tasks: svc as never, reads: { listOrganizations: async () => ORGS } as never, branchWrite: f.branchWrite as never, config: { id: 'o2', reason: 'cleanup' }, resumeWait: { taskId: t.id } as never }).c as never);
    assert.equal(out.removed, true);
    assert.ok(f.queries.some((q) => q.startsWith('delete from organizations')));
    // Already absent at apply time: idempotent, no failure.
    const svc2 = fakeTasks();
    await assert.rejects(run1('lyam-propose-org-removal', mk({ tasks: svc2 as never, reads: { listOrganizations: async () => ORGS } as never, config: { id: 'o2', reason: 'cleanup' } }).c as never), /waiting/);
    const t2 = svc2.approve([...svc2.tasks.keys()][0]);
    const gone = { orgs: ORGS.orgs.filter((o) => o.id !== 'o2'), members: ORGS.members };
    const out2 = await run1('lyam-propose-org-removal', mk({ tasks: svc2 as never, reads: { listOrganizations: async () => gone } as never, config: { id: 'o2', reason: 'cleanup' }, resumeWait: { taskId: t2.id } as never }).c as never);
    assert.equal(out2.removed, false); assert.equal(out2.alreadyAbsent, true);
  });
});

describe('completion: applications (module validators, disable-before-delete)', () => {
  const APP_ROW = { id: 'app1', name: 'App One', description: '', protocol: 'oidc', enabled: 0, config: JSON.stringify({ redirect_uris: ['https://app.example/callback'], entity_id: null, acs_url: null, attribute_mapping: {}, allowed_roles: [], secret_ref: null, launch_url: null, sp_certificate: null, want_signed_requests: false, nameid_format: null, scopes: ['profile'], allow_refresh_tokens: true, logo: null }) };
  it('lyam-set-application-enabled goes through the module build() validators', async () => {
    const f = fakeDb([{ match: 'select * from app_connectors', result: [[APP_ROW]] }]);
    const vcfg = externalBlock('lyam-set-application-enabled')!.validate({ id: 'app1', value: 'yes' } as never);
    const { c } = mk({ branchWrite: f.branchWrite as never, config: vcfg });
    const out = await run1('lyam-set-application-enabled', c as never);
    assert.deepEqual({ id: out.id, changed: out.changed }, { id: 'app1', changed: true });
    assert.ok(f.queries.find((q) => q.startsWith('update app_connectors')));
  });

  it('lyam-set-application-enabled rejects a value other than yes/no at definition time', () => {
    assert.throws(() => externalBlock('lyam-set-application-enabled')!.validate({ id: 'app1', value: 'maybe' } as never), /yes or no/);
    // The roles themselves are validated by the module build() at run time (covered in the next test).
  });

  it('lyam-set-application-roles validates the roles through the module build()', async () => {
    const f = fakeDb([{ match: 'select * from app_connectors', result: [[APP_ROW]] }]);
    const vcfg = externalBlock('lyam-set-application-roles')!.validate({ id: 'app1', value: 'admin, staff' } as never);
    const { c } = mk({ branchWrite: f.branchWrite as never, config: vcfg });
    assert.equal((await run1('lyam-set-application-roles', c as never)).changed, true);
    const f2 = fakeDb([{ match: 'select * from app_connectors', result: [[APP_ROW]] }]);
    await assert.rejects(run1('lyam-set-application-roles', mk({ branchWrite: f2.branchWrite as never, config: { id: 'app1', value: { allowed_roles: ['bad role!'] } } }).c as never), /invalid role id/);
    assert.equal(f2.queries.some((q) => q.startsWith('update')), false);
  });

  it('lyam-propose-application-removal refuses an enabled application and re-reads the state at apply time', async () => {
    const enabled = { applications: [{ id: 'app1', enabled: true, name: 'App One', protocol: 'oidc', allowedRoles: [] }] };
    const svc = fakeTasks();
    await assert.rejects(run1('lyam-propose-application-removal', mk({ tasks: svc as never, reads: { listApplications: async () => enabled } as never, config: { id: 'app1', reason: 'unused' } }).c as never), /disable it first/);
    assert.equal(svc.tasks.size, 0);
    // Disabled: the task opens; re-enabled before apply: refused; back to disabled with the same state: removed.
    const disabled = { applications: [{ id: 'app1', enabled: false, name: 'App One', protocol: 'oidc', allowedRoles: ['admin'] }] };
    await assert.rejects(run1('lyam-propose-application-removal', mk({ tasks: svc as never, reads: { listApplications: async () => disabled } as never, config: { id: 'app1', reason: 'unused' } }).c as never), /waiting for application-removal/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    const reenabled = { applications: [{ ...disabled.applications[0], enabled: true }] };
    await assert.rejects(run1('lyam-propose-application-removal', mk({ tasks: svc as never, reads: { listApplications: async () => reenabled } as never, config: { id: 'app1', reason: 'unused' }, resumeWait: { taskId: t.id } as never }).c as never), /disable it first/);
    const changed = { applications: [{ ...disabled.applications[0], name: 'Renamed' }] };
    await assert.rejects(run1('lyam-propose-application-removal', mk({ tasks: svc as never, reads: { listApplications: async () => changed } as never, config: { id: 'app1', reason: 'unused' }, resumeWait: { taskId: t.id } as never }).c as never), /changed since the approval/);
    const f = fakeDb([{ match: 'delete from app_connectors', result: [{ affectedRows: 1 }] }]);
    const out = await run1('lyam-propose-application-removal', mk({ tasks: svc as never, reads: { listApplications: async () => disabled } as never, branchWrite: f.branchWrite as never, config: { id: 'app1', reason: 'unused' }, resumeWait: { taskId: t.id } as never }).c as never);
    assert.equal(out.removed, true);
    assert.ok(f.queries.some((q) => q.includes('and enabled = 0')));
  });
});

describe('completion: validated CSV / SCIM-like imports', () => {
  const CSV = 'identity_id,display_name,manager_id,department,role_id\nu1,Alice,,Eng,admin\nu2,Bob,u1,Eng,staff';
  const csvDb = () => fakeDb([{ match: 'select id, is_sensitive from roles', result: [[{ id: 'admin', is_sensitive: 0 }, { id: 'staff', is_sensitive: 0 }]] }, { match: 'select id from identities', result: [[]] }, { match: 'from assignments', result: [[]] }]);
  it('lyam-import-csv stages the rows on the run branch and runs the SoD simulation', async () => {
    const f = csvDb();
    const out = await run1('lyam-import-csv', mk({ branchWrite: f.branchWrite as never, config: { payload: CSV } }).c as never);
    assert.deepEqual({ rows: out.rows, staged: out.staged, mergeable: out.mergeable, violations: out.violations }, { rows: 2, staged: true, mergeable: true, violations: [] });
    assert.equal(f.queries.filter((q) => q.startsWith('insert into identities')).length, 2);
    assert.ok(f.queries.some((q) => q.includes('sod_rules')));
  });

  it('lyam-import-csv refuses a wrong header, too many rows and unknown roles', async () => {
    assert.throws(() => externalBlock('lyam-import-csv')!.validate({ payload: 'a,b\n1,2' } as never), /header must be/);
    const big = 'identity_id,display_name,manager_id,department,role_id\n' + Array.from({ length: 501 }, (_, i) => `u${i},N${i},,D,admin`).join('\n');
    await assert.rejects(run1('lyam-import-csv', mk({ branchWrite: csvDb().branchWrite as never, config: { payload: big } }).c as never), /1 to 500 rows/);
    const f = fakeDb([{ match: 'select id, is_sensitive from roles', result: [[{ id: 'staff', is_sensitive: 0 }]] }]);
    await assert.rejects(run1('lyam-import-csv', mk({ branchWrite: f.branchWrite as never, config: { payload: CSV } }).c as never), /unknown role/);
    assert.equal(f.queries.some((q) => q.startsWith('insert into identities')), false);
  });

  it('lyam-import-csv refuses a sensitive role and reports the identities it would overwrite', async () => {
    const sensitive = fakeDb([{ match: 'select id, is_sensitive from roles', result: [[{ id: 'admin', is_sensitive: 1 }, { id: 'staff', is_sensitive: 0 }]] }]);
    await assert.rejects(run1('lyam-import-csv', mk({ branchWrite: sensitive.branchWrite as never, config: { payload: CSV } }).c as never), /sensitive role/);
    assert.equal(sensitive.queries.some((q) => q.startsWith('insert into identities')), false);
    const dup = fakeDb([{ match: 'select id, is_sensitive from roles', result: [[{ id: 'admin', is_sensitive: 0 }, { id: 'staff', is_sensitive: 0 }]] }, { match: 'select id from identities', result: [[{ id: 'u1' }]] }, { match: 'from assignments', result: [[]] }]);
    const out = await run1('lyam-import-csv', mk({ branchWrite: dup.branchWrite as never, config: { payload: CSV } }).c as never);
    assert.deepEqual(out.overwrites, ['u1']);
  });

  it('lyam-import-scim stages one row per (user, role) and reports the skipped ones', async () => {
    const f = csvDb();
    const payload = JSON.stringify({ Resources: [
      { userName: 'u1', displayName: 'Alice', roles: [{ value: 'admin' }, { value: 'staff' }] },
      { userName: 'u2', displayName: 'Bob', active: false, roles: [{ value: 'staff' }] },
    ] });
    const out = await run1('lyam-import-scim', mk({ branchWrite: f.branchWrite as never, config: { payload } }).c as never);
    assert.deepEqual({ rows: out.rows, skipped: out.skipped, staged: out.staged }, { rows: 2, skipped: 1, staged: true });
    assert.throws(() => externalBlock('lyam-import-scim')!.validate({ payload: '{not json' } as never), /not valid JSON/);
  });
});

describe('completion: mail templates and theme (render/validate before any write)', () => {
  it('lyam-read-mail-templates lists the catalogue without bodies', async () => {
    const reads = { listMailTemplates: async () => ({ templates: [{ key: 'p.welcome', customized: false }, { key: 'p.reset', customized: true }] }) };
    const out = await run1('lyam-read-mail-templates', mk({ reads: reads as never, config: {} }).c as never);
    assert.equal((out.templates as unknown[]).length, 2);
  });

  it('lyam-preview-mail-template renders without saving and passes sample data through', async () => {
    const calls: unknown[][] = [];
    const reads = { previewMailTemplate: async (...a: unknown[]) => { calls.push(a); return { subject: 'Hi Alice', html: '<p>x</p>' }; } };
    const out = await run1('lyam-preview-mail-template', mk({ reads: reads as never, config: { key: 'p.welcome', data: '{"firstName":"Alice"}' } }).c as never);
    assert.equal(out.subject, 'Hi Alice');
    assert.deepEqual(calls[0].slice(0, 4), ['acme', 'main', 'p.welcome', { firstName: 'Alice' }]);
  });

  it('lyam-propose-mail-template renders the exact candidate first, then writes the override on the run branch', async () => {
    const f = fakeDb();
    let previewed: unknown[] = [];
    const reads = { previewMailTemplate: async (...a: unknown[]) => { previewed = a; return { subject: 'New', html: '<p>ok</p>' }; } };
    const out = await run1('lyam-propose-mail-template', mk({ reads: reads as never, branchWrite: f.branchWrite as never, runBranch: 'run-1-branch' as never, config: { key: 'p.welcome', subject: 'New subject' } }).c as never);
    assert.equal(out.saved, true);
    assert.deepEqual(previewed.slice(0, 3), ['acme', 'run-1-branch', 'p.welcome']);
    assert.deepEqual(previewed[4], { subject: 'New subject', text: undefined });
    assert.ok(f.queries.some((q) => q.includes('plg_mail_templates_custom')));
    // A candidate that does not render is refused BEFORE any write.
    const f2 = fakeDb();
    const broken = { previewMailTemplate: async () => { throw new Error('unknown variable'); } };
    await assert.rejects(run1('lyam-propose-mail-template', mk({ reads: broken as never, branchWrite: f2.branchWrite as never, config: { key: 'p.welcome', subject: 'x {{oops}}' } }).c as never), /unknown variable/);
    assert.equal(f2.queries.length, 0);
    assert.throws(() => externalBlock('lyam-propose-mail-template')!.validate({ key: 'p.welcome' } as never), /at least one of subject, text or html/);
    assert.throws(() => externalBlock('lyam-propose-mail-template')!.validate({ key: 'p.welcome', html: '<p onclick="x()">hi</p>' } as never), /active content/);
    assert.throws(() => externalBlock('lyam-propose-mail-template')!.validate({ key: 'p.welcome', html: '<script>alert(1)</script>' } as never), /active content/);
  });

  it('lyam-preview-theme validates a candidate without storing anything', async () => {
    const reads = { validateTheme: async () => ({ valid: true, provider: 'builtin', summary: { primaryColor: '#123456' }, version: 3 }) };
    const out = await run1('lyam-preview-theme', mk({ reads: reads as never, config: { theme: '{"primaryColor":"#123456"}' } }).c as never);
    assert.deepEqual({ valid: out.valid, provider: out.provider }, { valid: true, provider: 'builtin' });
    const bad = { validateTheme: async () => ({ valid: false, provider: 'builtin', errors: ['contrast too low'] }) };
    await assert.rejects(run1('lyam-preview-theme', mk({ reads: bad as never, config: { theme: '{}' } }).c as never), /contrast too low/);
  });

  it('lyam-propose-theme merges over the current settings, validates the RESULT and stores it on the run branch', async () => {
    const seen: unknown[] = [];
    const reads = {
      themeSettings: async () => ({ provider: 'builtin', settings: { primaryColor: '#111111', accentColor: '#222222' } }),
      validateTheme: async (_t: string, _r: string, input: unknown) => { seen.push(input); return { valid: true, provider: 'builtin', values: input, summary: {} }; },
    };
    const f = fakeDb();
    const vcfg = externalBlock('lyam-propose-theme')!.validate({ theme: '{"primaryColor":"#333333"}' } as never);
    const out = await run1('lyam-propose-theme', mk({ reads: reads as never, branchWrite: f.branchWrite as never, runBranch: 'run-1-branch' as never, config: vcfg }).c as never);
    assert.equal(out.saved, true);
    assert.deepEqual(seen[0], { primaryColor: '#333333', accentColor: '#222222' });
    assert.ok(f.queries.some((q) => q.includes('plugin_runtime_settings')));
    const invalid = { themeSettings: reads.themeSettings, validateTheme: async () => ({ valid: false, provider: 'builtin', errors: ['contrast too low'] }) };
    const f2 = fakeDb();
    await assert.rejects(run1('lyam-propose-theme', mk({ reads: invalid as never, branchWrite: f2.branchWrite as never, config: vcfg }).c as never), /merged theme is invalid/);
    assert.equal(f2.queries.length, 0);
  });
});

describe('completion: authentication (reads, reinforced policy, immediate re-enrollment)', () => {
  it('lyam-read-authn returns the structure only, lyam-read-enrollments the live factor status', async () => {
    const reads = { authnConfig: async () => ({ methods: [{ id: 'm1', type: 'totp', name: 'TOTP', enabled: true, level: 2 }], chains: [], defaultChain: null }) };
    const out = await run1('lyam-read-authn', mk({ reads: reads as never, config: {} }).c as never);
    assert.equal((out.methods as unknown[]).length, 1);
    const authn = { enrollments: async () => ({ 'm1:i1': { totp: true, pin: false }, 'm2:i1': {} }) };
    const out2 = await run1('lyam-read-enrollments', mk({ authn: authn as never, config: { user: 'u1' } }).c as never);
    assert.deepEqual(out2.instances, [{ instance: 'm1:i1', kinds: ['totp'], enrolled: true }, { instance: 'm2:i1', kinds: [], enrolled: false }]);
  });

  it('lyam-propose-authn-policy validates first, opens a reinforced task with redacted secrets, writes on the run branch after approval', async () => {
    const svc = fakeTasks();
    const saved: unknown[] = [];
    const authn = { validatePolicy: () => ({ valid: true, errors: [] }), savePolicy: async (...a: unknown[]) => { saved.push(a); } };
    const policy = JSON.stringify({ methods: [{ id: 'm1', type: 'totp' }], chains: [] });
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svc as never, authn: authn as never, config: { config: policy, reason: 'align' } }).c as never), /waiting for authn-policy-change/);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.kind, 'authn-policy-change');
    assert.equal(t.assignee, 'admin');
    assert.equal(t.preventSelfApproval, true);
    assert.equal(typeof (t.detail as { configHash?: string }).configHash, 'string');
    // An inline secret value is refused outright: secrets stay in the server-side store, referenced by name.
    const svcSec = fakeTasks();
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svcSec as never, authn: authn as never, config: { config: JSON.stringify({ methods: [{ id: 'm1', type: 'totp', secret: 'TOPSECRET' }] }), reason: 'align' } }).c as never), /server-side store/);
    assert.equal(svcSec.tasks.size, 0);
    // No workflow placeholders: the approved object is exactly the applied object.
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svcSec as never, authn: authn as never, config: { config: JSON.stringify({ methods: "{{steps.prev.outputs.methods}}" }), reason: 'align' } }).c as never), /placeholders/);
    // An invalid candidate never opens a task.
    const svc2 = fakeTasks();
    const badAuthn = { validatePolicy: () => ({ valid: false, errors: ['chain references a disabled method'] }) };
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svc2 as never, authn: badAuthn as never, config: { config: policy, reason: 'align' } }).c as never), /chain references a disabled method/);
    assert.equal(svc2.tasks.size, 0);
    // After approval the configuration is written on the RUN branch, never on main directly.
    svc.approve(t.id as string);
    const out = await run1('lyam-propose-authn-policy', mk({ tasks: svc as never, authn: authn as never, runBranch: 'run-1-branch' as never, config: { config: policy, reason: 'align' }, resumeWait: { taskId: t.id } as never }).c as never);
    assert.equal(out.applied, true);
    assert.deepEqual(saved[0], ['acme', { branch: 'run-1-branch', input: { methods: [{ id: 'm1', type: 'totp' }], chains: [] } }]);
    // A candidate changed after the approval no longer matches the recorded hash: refused.
    const svc4 = fakeTasks();
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svc4 as never, authn: authn as never, config: { config: policy, reason: 'align' } }).c as never), /waiting/);
    const t4 = svc4.approve([...svc4.tasks.keys()][0]);
    const other = JSON.stringify({ methods: [{ id: 'm1', type: 'totp' }, { id: 'm2', type: 'pin' }], chains: [] });
    await assert.rejects(run1('lyam-propose-authn-policy', mk({ tasks: svc4 as never, authn: authn as never, runBranch: 'run-1-branch' as never, config: { config: other, reason: 'align' }, resumeWait: { taskId: t4.id } as never }).c as never), /no longer matches the approved one/);
    assert.equal(saved.length, 1);
  });

  it('lyam-request-reenrollment proposes only for an enrolled factor; applies immediately with a durable intent; never enrolls for the holder', async () => {
    const svc = fakeTasks();
    const none = { targetIsAdmin: () => false, enrollments: async () => ({}) };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: none as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' } }).c as never), /no enrollment/);
    assert.equal(svc.tasks.size, 0);
    const effects: string[] = [];
    const authn = {
      targetIsAdmin: () => false,
      enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }),
      unenroll: async () => { effects.push('unenroll'); return { removed: true }; },
      notify: async (_t: string, m: Record<string, unknown>) => { effects.push(`notify:${m.to}:${m.subjectUser}`); },
    };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' } }).c as never), /waiting for reenrollment-request/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    const intents: unknown[] = [];
    const out = await run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, markEffectPending: (async (i: unknown) => { intents.push(i); }) as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' }, resumeWait: { taskId: t.id } as never }).c as never);
    assert.deepEqual({ removed: out.removed, notified: out.notified }, { removed: true, notified: true });
    assert.deepEqual(intents, [{ action: 'reenrollment-request', user: 'u1', instance: 'm1:i1' }]);
    assert.deepEqual(effects, ['unenroll', 'notify:u1:u1']);
    // The durable intent mechanism is mandatory: without it the effect never fires.
    const svc3 = fakeTasks();
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc3 as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' } }).c as never), /waiting/);
    const t3 = svc3.approve([...svc3.tasks.keys()][0]);
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc3 as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' }, resumeWait: { taskId: t3.id } as never }).c as never), /durable intent mechanism/);
  });

  it('lyam-request-reenrollment refuses an administrator and a last enrolled factor, at proposal and apply time', async () => {
    const svc = fakeTasks();
    const adminTarget = { targetIsAdmin: () => true, enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }) };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: adminTarget as never, config: { user: 'root', instance: 'm1:i1', reason: 'r' } }).c as never), /administrator/);
    assert.equal(svc.tasks.size, 0);
    const lastFactor = { targetIsAdmin: () => false, enrollments: async () => ({ 'm1:i1': { totp: true } }) };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: lastFactor as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' } }).c as never), /last enrolled factor/);
    assert.equal(svc.tasks.size, 0);
    // At apply time the target became the last-factor case: refused before the durable intent is recorded.
    const svc2 = fakeTasks();
    const twoFactors = { targetIsAdmin: () => false, enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }), unenroll: async () => ({ removed: true }), notify: async () => undefined };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc2 as never, authn: twoFactors as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' } }).c as never), /waiting/);
    const t2 = svc2.approve([...svc2.tasks.keys()][0]);
    let intent = 0;
    const shrunk = { ...twoFactors, enrollments: async () => ({ 'm1:i1': { totp: true } }) };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc2 as never, authn: shrunk as never, markEffectPending: (async () => { intent++; }) as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' }, resumeWait: { taskId: t2.id } as never }).c as never), /last enrolled factor/);
    assert.equal(intent, 0);
  });

  it('lyam-request-reenrollment does not notify when the factor is already gone at apply time', async () => {
    const svc = fakeTasks();
    let notified = 0;
    const authn = { targetIsAdmin: () => false, enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }), unenroll: async () => ({ removed: false }), notify: async () => { notified++; } };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' } }).c as never), /waiting/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    const out = await run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, markEffectPending: (async () => undefined) as never, config: { user: 'u1', instance: 'm1:i1', reason: 'lost phone' }, resumeWait: { taskId: t.id } as never }).c as never);
    assert.deepEqual({ removed: out.removed, notified: out.notified, alreadyAbsent: out.alreadyAbsent }, { removed: false, notified: false, alreadyAbsent: true });
    assert.equal(notified, 0);
  });

  it('lyam-propose-password-reset validates the window and only opens a task', async () => {
    assert.throws(() => externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '0', reason: 'r' } as never), /hours/);
    assert.throws(() => externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '721', reason: 'r' } as never), /hours/);
    const svc = fakeTasks();
    const vcfg = externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '24', reason: 'forgotten' } as never);
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svc as never, config: vcfg }).c as never), /waiting for lyam-propose-password-reset/);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.preventSelfApproval, true);
    assert.equal(t.assignee, 'admin');
    assert.equal((t.detail as { hours: string }).hours, '24');
  });
});

describe('completion: plugin protections (reinforced validation)', () => {
  it('lyam-propose-plugin-change flags an auth-* disable as reinforced and forces the admin pool', async () => {
    const svc = fakeTasks();
    const vcfg = externalBlock('lyam-propose-plugin-change')!.validate({ plugin: 'auth-totp', action: 'disable', assignee: 'manager' } as never);
    await assert.rejects(run1('lyam-propose-plugin-change', mk({ tasks: svc as never, config: vcfg }).c as never), /waiting for lyam-propose-plugin-change-reinforced/);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.kind, 'lyam-propose-plugin-change-reinforced');
    assert.equal(t.assignee, 'admin');
    assert.equal((t.detail as { reinforced?: string }).reinforced, 'protection-change');
  });

  it('lyam-propose-plugin-change keeps an ordinary change on the normal kind', async () => {
    const svc = fakeTasks();
    const vcfg = externalBlock('lyam-propose-plugin-change')!.validate({ plugin: 'app-connector', action: 'settings', proposal: '{"x":1}' } as never);
    await assert.rejects(run1('lyam-propose-plugin-change', mk({ tasks: svc as never, config: vcfg }).c as never), /waiting for lyam-propose-plugin-change /);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.kind, 'lyam-propose-plugin-change');
    assert.equal((t.detail as { reinforced?: string }).reinforced, undefined);
  });
});
