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
    consume: async (_tenant: string, id: string, consumer: string) => { const t = tasks.get(id)!; const d = (t.detail ?? {}) as Record<string, unknown>; if (d.appliedBy) throw new Error('this approval already produced its effect: it is burned'); if (d.consumedBy && d.consumedBy !== consumer) throw new Error('this approval was already consumed by another step'); t.detail = { ...d, consumedBy: consumer }; },
    markApplied: async (_tenant: string, id: string, consumer: string, revision: string) => { const t = tasks.get(id)!; const d = (t.detail ?? {}) as Record<string, unknown>; if (d.consumedBy !== consumer || d.appliedBy) throw new Error('the effect of this approval could not be recorded for this consumer'); t.detail = { ...d, appliedBy: consumer, appliedRevision: revision }; },
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

  it('lyam-request-reenrollment refuses at APPLY time when the target became an administrator after approval', async () => {
    const svc = fakeTasks();
    let isAdmin = false;
    const authn = { targetIsAdmin: () => isAdmin, enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }), unenroll: async () => ({ removed: true }), notify: async () => undefined };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' } }).c as never), /waiting/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    isAdmin = true; // the target was promoted to administrator after the approval
    let intent = 0, removed = 0;
    const authn2 = { ...authn, unenroll: async () => { removed++; return { removed: true }; } };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn2 as never, markEffectPending: (async () => { intent++; }) as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' }, resumeWait: { taskId: t.id } as never }).c as never), /administrator/);
    assert.equal(intent, 0, 'no durable intent recorded: the refusal precedes it');
    assert.equal(removed, 0, 'the factor was never touched');
  });

  it('lyam-request-reenrollment task carries detail.subject so the beneficiary is barred from deciding', async () => {
    const svc = fakeTasks();
    const authn = { targetIsAdmin: () => false, enrollments: async () => ({ 'm1:i1': { totp: true }, 'm2:i1': { pin: true } }) };
    await assert.rejects(run1('lyam-request-reenrollment', mk({ tasks: svc as never, authn: authn as never, config: { user: 'u1', instance: 'm1:i1', reason: 'r' } }).c as never), /waiting/);
    assert.equal(([...svc.tasks.values()][0].detail as { subject: string }).subject, 'u1');
  });

  it('lyam-propose-password-reset refuses to consume an approval when the target became an administrator', async () => {
    const vcfg = externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '24', reason: 'r' } as never);
    const svc = fakeTasks();
    let isAdmin = false;
    const authn = { targetIsAdmin: () => isAdmin };
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svc as never, authn: authn as never, reads: { readUser: async () => ({}) } as never, config: vcfg }).c as never), /waiting/);
    const t = svc.approve([...svc.tasks.keys()][0]);
    const resume = () => run1('lyam-propose-password-reset', mk({ tasks: svc as never, authn: authn as never, config: vcfg, resumeWait: { taskId: t.id } as never }).c as never);
    assert.equal((await resume()).decision, 'approved');
    isAdmin = true;
    await assert.rejects(resume(), /became an administrator/);
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

  it('lyam-propose-password-reset validates the window, refuses an admin target and an unknown user, and only opens a task', async () => {
    assert.throws(() => externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '0', reason: 'r' } as never), /hours/);
    assert.throws(() => externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '721', reason: 'r' } as never), /hours/);
    const vcfg = externalBlock('lyam-propose-password-reset')!.validate({ subject: 'u1', hours: '24', reason: 'forgotten' } as never);
    const okAuthn = { targetIsAdmin: () => false };
    const okReads = { readUser: async () => ({ id: 'u1' }) };
    // An administrator target is refused before any task opens.
    const svcA = fakeTasks();
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svcA as never, authn: { targetIsAdmin: () => true } as never, reads: okReads as never, config: vcfg }).c as never), /administrator/);
    assert.equal(svcA.tasks.size, 0);
    // An unknown identity is refused (the read service throws), before any task opens.
    const svcU = fakeTasks();
    const noUser = { readUser: async () => { throw new Error('unknown identity "u1"'); } };
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svcU as never, authn: okAuthn as never, reads: noUser as never, config: vcfg }).c as never), /unknown identity/);
    assert.equal(svcU.tasks.size, 0);
    const svc = fakeTasks();
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svc as never, authn: okAuthn as never, reads: okReads as never, config: vcfg }).c as never), /waiting for lyam-propose-password-reset/);
    const t = [...svc.tasks.values()][0];
    assert.equal(t.preventSelfApproval, true);
    assert.equal(t.assignee, 'admin');
    assert.equal((t.detail as { hours: string, subject: string }).hours, '24');
    assert.equal((t.detail as { subject: string }).subject, 'u1');
    // A refused decision comes back as a decision; a canceled task fails honestly.
    t.status = 'decided'; t.decision = 'refused'; t.decided_by = 'root'; t.justification = 'not verified';
    const out = await run1('lyam-propose-password-reset', mk({ tasks: svc as never, authn: okAuthn as never, reads: okReads as never, config: vcfg, resumeWait: { taskId: t.id } as never }).c as never);
    assert.deepEqual({ decision: out.decision, decidedBy: out.decidedBy }, { decision: 'refused', decidedBy: 'root' });
    const svc2 = fakeTasks();
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svc2 as never, authn: okAuthn as never, reads: okReads as never, config: vcfg }).c as never), /waiting/);
    const t2 = [...svc2.tasks.values()][0]; t2.status = 'canceled';
    await assert.rejects(run1('lyam-propose-password-reset', mk({ tasks: svc2 as never, authn: okAuthn as never, reads: okReads as never, config: vcfg, resumeWait: { taskId: t2.id } as never }).c as never), /canceled/);
    // A test run opens nothing.
    const svc3 = fakeTasks();
    const dry = await run1('lyam-propose-password-reset', mk({ test: true, tasks: svc3 as never, authn: okAuthn as never, reads: okReads as never, config: vcfg }).c as never);
    assert.equal(dry.taskId, 'test'); assert.equal(svc3.tasks.size, 0);
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

describe('completion: password reset approval -> effect binding', () => {
  const APPLY = () => externalBlock('lyam-apply-password-reset')!;
  const setup = (over: Record<string, unknown> = {}) => {
    const svc = fakeTasks();
    const t = { id: 'task-r', kind: 'lyam-propose-password-reset', run_id: 'run-1', detail: { subject: 'u1', hours: '24' }, ...over };
    svc.tasks.set('task-r', { status: 'open', ...t });
    svc.approve('task-r');
    const writes: unknown[] = [];
    let isAdmin = false;
    const base = { tasks: svc as never, authn: { targetIsAdmin: () => isAdmin, adminsConfigured: () => true } as never, secrets: { reveal: () => 'x' } as never, setTemporaryPassword: (async (a: unknown) => { writes.push(a); return { revision: 'rev12345', expiresAt: Date.now() + 1000 }; }) as never };
    const cfg = (o: Record<string, string> = {}) => APPLY().validate({ approvalTaskId: 'task-r', subject: 'u1', passwordRef: 'ref', hours: '24', ...o } as never);
    return { svc, writes, base, cfg, promote: () => { isAdmin = true; } };
  };
  it('applies only the approved reset bound to this run, this account and this validity', async () => {
    const s = setup();
    const out = await run1('lyam-apply-password-reset', mk({ ...s.base, config: s.cfg() }).c as never);
    assert.equal(out.subject, 'u1'); assert.equal(s.writes.length, 1);
  });
  it('refuses a substituted target, a different validity, another run, a non-reset task and a refused or open task', async () => {
    const s = setup();
    for (const [cfgOver, re] of [[{ subject: 'u2' }, /another account/], [{ hours: '48' }, /another validity/]] as const) {
      await assert.rejects(run1('lyam-apply-password-reset', mk({ ...s.base, config: s.cfg(cfgOver) }).c as never), re);
    }
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...setup({ run_id: 'run-9' }).base, config: s.cfg() }).c as never), /another run/);
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...setup({ kind: 'lyam-request-approval' }).base, config: s.cfg() }).c as never), /not a password reset proposal/);
    const refused = setup(); const rt = refused.svc.tasks.get('task-r')!; rt.decision = 'refused';
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...refused.base, config: s.cfg() }).c as never), /not an approved decision/);
    const open = setup(); open.svc.tasks.get('task-r')!.status = 'open';
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...open.base, config: s.cfg() }).c as never), /not an approved decision/);
    assert.equal(s.writes.length + refused.writes.length + open.writes.length, 0);
  });
  it('refuses a target promoted to administrator after the approval, before any credential is written', async () => {
    const s = setup();
    s.promote();
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...s.base, config: s.cfg() }).c as never), /administrator now/);
    assert.equal(s.writes.length, 0);
  });
  it('the secret mail carrying the approval re-checks it right before sending (promotion after the credential step)', async () => {
    const s = setup();
    const mail = externalBlock('lyam-send-secret-mail')!;
    const vcfg = mail.validate({ account: 'u1', to: 'u1@example.test', subject: 's', text: 'p [[password]] e [[expiry]]', passwordRef: 'ref', hours: '24', revision: 'rev', ownerRun: 'r0', sourceHead: 'h', resetApprovalTaskId: 'task-r' } as never);
    assert.equal((vcfg as { resetApprovalTaskId?: string }).resetApprovalTaskId, 'task-r');
    Object.assign(s.svc.tasks.get('task-r')!.detail as Record<string, unknown>, { consumedBy: 'run-1:n1', appliedBy: 'run-1:n1', appliedRevision: 'rev' });
    s.promote();
    const prev = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'fake-not-used';
    try {
      await assert.rejects(run1('lyam-send-secret-mail', mk({ ...s.base, markEffectPending: (async () => undefined) as never, settings: { mailAllowedRecipients: 'u1@example.test' }, config: vcfg }).c as never), /administrator now/);
    } finally { if (prev === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prev; }
    // Without the optional field the generic block validates exactly as before.
    assert.equal('resetApprovalTaskId' in (mail.validate({ account: 'u1', to: 'u1@example.test', subject: 's', text: 'p [[password]] e [[expiry]]', passwordRef: 'ref', hours: '24', revision: 'rev', ownerRun: 'r0', sourceHead: 'h' } as never) as object), false);
  });
  it('a test run writes nothing', async () => {
    const s = setup();
    const out = await run1('lyam-apply-password-reset', mk({ ...s.base, test: true, config: s.cfg() }).c as never);
    assert.equal(out.revision, null); assert.equal(s.writes.length, 0);
  });
});

describe('completion: the delivered reset template is wired to the bound steps', () => {
  it('validates, and uses apply (not the generic set), the approval task on apply and mail, and the block owner run', async () => {
    const { OFFICIAL_TEMPLATES } = await import('./templates-catalog.js');
    const { validateGraph } = await import('./model.js');
    const t = OFFICIAL_TEMPLATES.find((x) => x.id === 'password-reset-approved')!;
    assert.ok(t);
    const { order } = validateGraph({ nodes: t.nodes, edges: t.edges } as never);
    const n = (id: string) => t.nodes.find((x) => x.id === id) as { type: string; config: Record<string, string> };
    assert.equal(t.nodes.some((x) => x.type === 'lyam-set-temporary-password'), false);
    assert.equal(n('apply').type, 'lyam-apply-password-reset');
    assert.equal(n('apply').config.approvalTaskId, '{{steps.propose.taskId}}');
    assert.equal(n('mail').config.resetApprovalTaskId, '{{steps.propose.taskId}}');
    assert.equal(n('mail').config.revision, '{{steps.apply.revision}}');
    assert.equal(n('mail').config.ownerRun, '{{steps.block.ownerRun}}');
    const pos = (id: string) => order.indexOf(id);
    assert.ok(pos('propose') < pos('apply') && pos('apply') < pos('publish') && pos('publish') < pos('mail') && pos('mail') < pos('unblock'));
    // Every node config is accepted by its block validator (placeholders pass through).
    for (const x of t.nodes) { const b = externalBlock(x.type); if (b) assert.doesNotThrow(() => b.validate(x.config as never), x.id); }
  });
});

describe('completion: the approval is consumed once, durably', () => {
  const setup2 = () => {
    const svc = fakeTasks();
    svc.tasks.set('task-r', { id: 'task-r', status: 'open', kind: 'lyam-propose-password-reset', run_id: 'run-1', detail: { subject: 'u1', hours: '24' } });
    svc.approve('task-r');
    const writes: unknown[] = [];
    const base = { tasks: svc as never, authn: { targetIsAdmin: () => false, adminsConfigured: () => true } as never, secrets: { reveal: () => 'x' } as never, setTemporaryPassword: (async (a: unknown) => { writes.push(a); return { revision: 'rev12345', expiresAt: Date.now() + 1000 }; }) as never };
    const cfg = APPLY2().validate({ approvalTaskId: 'task-r', subject: 'u1', passwordRef: 'ref', hours: '24' } as never);
    return { svc, writes, base, cfg };
  };
  const APPLY2 = () => externalBlock('lyam-apply-password-reset')!;
  it('another apply node on the same approval is refused with no write', async () => {
    const s = setup2();
    await run1('lyam-apply-password-reset', mk({ ...s.base, nodeId: 'n1', config: s.cfg }).c as never);
    assert.equal(s.writes.length, 1);
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...s.base, nodeId: 'n2', config: s.cfg }).c as never), /already consumed|burned/);
    assert.equal(s.writes.length, 1);
  });
  it('publish and mail refuse an approval that no apply step of this run consumed', async () => {
    const s = setup2();
    const pub = externalBlock('lyam-publish-workspace')!;
    const vcfg = pub.validate({ resetApprovalTaskId: 'task-r', resetSubject: 'u1', resetHours: '24', resetRevision: 'rev12345' } as never);
    await assert.rejects(run1('lyam-publish-workspace', mk({ ...s.base, ...({ hasRunBranch: true, publishIntent: { branch: 'b', head: 'h' }, workspace: { publish: async () => ({ published: true, mainCommit: 'm' }) } } as Record<string, unknown>), config: vcfg }).c as never), /not applied by this run/);
  });
  it('an empty administrator list fails closed (the non-admin check would protect nothing)', async () => {
    const s = setup2();
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...s.base, authn: { targetIsAdmin: () => false, adminsConfigured: () => false } as never, nodeId: 'n1', config: s.cfg }).c as never), /list is empty/);
    assert.equal(s.writes.length, 0);
  });
  it('a failure after the consumption lets the SAME node retry, and nobody else', async () => {
    const s = setup2(); let fail = true;
    const flaky = { ...s.base, setTemporaryPassword: (async () => { if (fail) { fail = false; throw new Error('db down'); } return { revision: 'rev12345', expiresAt: Date.now() + 1000 }; }) as never };
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...flaky, nodeId: 'n1', config: s.cfg }).c as never), /db down/);
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...flaky, nodeId: 'n2', config: s.cfg }).c as never), /already consumed/);
    assert.equal((await run1('lyam-apply-password-reset', mk({ ...flaky, nodeId: 'n1', config: s.cfg }).c as never)).subject, 'u1');
  });
  it('burned approval: after the effect is recorded a second pass through the SAME node is refused with no write; publish/mail need the exact revision', async () => {
    const s = setup2();
    await run1('lyam-apply-password-reset', mk({ ...s.base, nodeId: 'n1', config: s.cfg }).c as never);
    assert.equal(s.writes.length, 1);
    await assert.rejects(run1('lyam-apply-password-reset', mk({ ...s.base, nodeId: 'n1', config: s.cfg }).c as never), /burned/);
    assert.equal(s.writes.length, 1);
    const pub = externalBlock('lyam-publish-workspace')!;
    const ctxWith = (rev: string) => mk({ ...s.base, ...({ hasRunBranch: true, publishIntent: { branch: 'b', head: 'h' }, workspace: { publish: async () => ({ published: true, mainCommit: 'm', branch: 'b', sourceHead: 'h' }) } } as Record<string, unknown>), config: pub.validate({ resetApprovalTaskId: 'task-r', resetSubject: 'u1', resetHours: '24', resetRevision: rev } as never) }).c as never;
    await assert.rejects(run1('lyam-publish-workspace', ctxWith('other-rev')), /not applied by this run with this credential revision/);
    assert.equal((await run1('lyam-publish-workspace', ctxWith('rev12345'))).published, true);
  });
});
