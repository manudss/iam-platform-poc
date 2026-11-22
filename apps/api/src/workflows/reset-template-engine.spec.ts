import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from './model.js';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { RunSecrets } from './run-secrets.js';
// The official 'password-reset-approved' template on the REAL engine and the real blocks. Fakes (doubles): store, versioning, users, accounts, workspace, tasks, authn, reads, the mail client.
// Nothing here proves real Dolt, the real tasks service or a real process crash: see the limits stated in the PR.
const { createWorkflowEngine } = loadPluginModule('workflows-iga', 'engine.mjs') as any;
const mailApi = loadPluginModule('workflow-connectors', 'mail-api.mjs') as any;
class FakeMail { static calls: any[] = []; emails = { send: async (payload: any, opts: any) => { FakeMail.calls.push({ payload, opts }); return { data: { id: 'msg-1' } }; } }; }
import { externalBlock as _eb } from './model.js';
const loadBlocks = () => ({ externalBlock: _eb });
const HOUR = 3_600_000;
const tpl = () => OFFICIAL_TEMPLATES.find((t) => t.id === 'password-reset-approved')!;

function world(opts: { onPublish?: () => void; onSet?: () => void; hangPublish?: boolean; stripPublishGuard?: boolean; errorLinkToPublish?: boolean; failMark?: boolean; test?: boolean } = {}) {
  const runId = 'run-r1', calls: string[] = [], secrets = new RunSecrets();
  const nodes = tpl().nodes.map((n: any) => (n.type === 'lyam-propose-password-reset' ? { ...n, config: { ...n.config, subject: 'bao' } } : opts.stripPublishGuard && n.type === 'lyam-publish-workspace' ? { ...n, config: {} } : n));
  const edges = opts.errorLinkToPublish ? [...tpl().edges.filter((e: any) => !(e.from === 'apply' && e.to === 'publish')), { from: 'apply', to: 'publish', label: 'error' }] : tpl().edges;
  const { graph, order } = validateGraph({ nodes, edges } as never);
  const row: any = { id: runId, tenant: 'acme', definition_id: 'wf-reset', name: 't', graph, branch: null, base_branch: null, status: 'queued', error: null, started_by: 'root', started_at: 'now', finished_at: null, test: !!opts.test };
  const steps = new Map<string, any>(); for (const id of order) steps.set(id, { run_id: runId, node_id: id, status: 'pending', simulated: false, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null });
  const store = { getRunById: async (id: string) => (id === runId ? row : null), updateRun: async (_i: string, p: any) => { Object.assign(row, p); }, transitionRun: async (_i: string, p: any, from: string[]) => { if (!from.includes(row.status)) return false; Object.assign(row, p); return true; }, runningRuns: async () => (row.status === 'running' ? [row] : []), step: async (_r: string, n: string) => steps.get(n) ?? null, steps: async () => [...steps.values()], patchStep: async (_r: string, n: string, p: any) => { Object.assign(steps.get(n), p); } };
  const state = { fa: null as any, blocks: [] as { kind: string; setBy: string }[], passwords: [] as string[], isAdmin: false, tasks: new Map<string, any>() };
  const tasks = {
    request: async (a: any) => { const t = { id: 'task-1', status: 'open', run_id: a.runId, node_id: a.nodeId, kind: a.kind, detail: a.detail, assignee: a.assignee, prevent_self: a.preventSelfApproval }; state.tasks.set(t.id, t); return t; },
    consume: async (_t: string, id: string, consumer: string) => { const t = state.tasks.get(id); const d = t.detail ?? {}; if (d.appliedBy) throw new Error('burned'); if (d.consumedBy && d.consumedBy !== consumer) throw new Error('already consumed'); t.detail = { ...d, consumedBy: consumer }; },
    markApplied: async (_t: string, id: string, consumer: string, revision: string) => { const t = state.tasks.get(id); const d = t.detail ?? {}; if (d.consumedBy !== consumer || d.appliedBy) throw new Error('not recorded'); t.detail = { ...d, appliedBy: consumer, appliedRevision: revision }; },
    check: async (_t: string, id: string) => { const t = state.tasks.get(id); return t?.status === 'open' ? { state: 'open', task: t } : { state: 'decided', task: t }; },
  };
  if (opts.failMark) { const m = tasks.markApplied; tasks.markApplied = async (...a: [string, string, string, string]) => { void m; throw new Error('recording failed'); }; }
  const MAIN = 'main000111222333', HEAD = 'abcdef0123456789';
  const deps: any = {
    store, secrets, log: { warn() {}, error() {} },
    versioning: { createBranch: async () => { if (opts.test) calls.push('createBranch'); return {}; }, writeOn: async (_b: string, fn: any) => { if (opts.test) calls.push('writeOn'); return fn({ query: async () => [[]] }); }, defaultBranch: 'main' },
    authorOf: (a: string) => a, branchRun: async (_b: string, fn: any) => fn(),
    settingsFor: async () => ({ mailAllowedRecipients: 'bao@example.test' }),
    tasks, authn: { targetIsAdmin: () => state.isAdmin, adminsConfigured: () => true },
    reads: { readUser: async (_t: string, _r: string, id: string) => ({ id, email: 'bao@example.test', roles: [] }) },
    users: {
      setTemporary: async (_t: string, a: any) => { calls.push('setTemporary'); opts.onSet?.(); state.passwords.push(a.password); state.fa = { required: true, expired: false, revision: 'rev-1', expiresAt: Date.now() + a.hours * HOUR }; return { revision: 'rev-1', expiresAt: state.fa.expiresAt }; },
      firstAccess: async () => state.fa, emailOf: async () => 'bao@example.test',
    },
    accounts: {
      block: async (_t: string, a: any) => { calls.push('block'); state.blocks.push({ kind: a.kind, setBy: `workflow:${a.runId}` }); return { applied: true, blockId: 'b1' }; },
      activeBlocks: async () => state.blocks.map((b) => ({ ...b })),
      unblock: async (_t: string, a: any) => { calls.push('unblock'); const own = a.ownerRun ? `workflow:${a.ownerRun}` : null; const lift = state.blocks.filter((b) => (!a.kind || b.kind === a.kind) && (!own || b.setBy === own)); state.blocks = state.blocks.filter((b) => !lift.includes(b)); return { lifted: lift.length, remaining: state.blocks.length }; },
    },
    workspace: { headOf: async () => HEAD, publish: async (_t: string, a: any) => { calls.push('publish'); opts.onPublish?.(); if (opts.hangPublish) return new Promise<never>(() => {}); return { published: true, branch: a.branch, sourceHead: a.expectedHead, mainCommit: MAIN, activation: 'applied' }; }, proof: async () => ({ mainCommit: MAIN, activation: 'applied', activationCommit: MAIN, containsHead: true }) },
  };
  const build = (sec?: any) => createWorkflowEngine(sec ? { ...deps, secrets: sec } : deps);
  return { row, steps, calls, state, secrets, build, engine: build(), approve: (decision = 'approved') => { const t = state.tasks.get('task-1'); t.status = 'decided'; t.decision = decision; t.decided_by = 'boss'; t.justification = decision === 'approved' ? null : 'no'; } };
}
type W = ReturnType<typeof world>;
async function settle(w: W, engine: any = w.engine) { engine.kick(w.row.id); for (const until = Date.now() + 10000; ; ) { await new Promise((r) => setTimeout(r, 30)); if (['completed', 'failed', 'canceled', 'waiting'].includes(w.row.status)) return w; if (Date.now() > until) throw new Error('no settle ' + w.row.status); } }
const withMail = async (fn: () => Promise<void>) => { const old = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'test-key-not-real'; const prev = mailApi.mailClient.Ctor; mailApi.mailClient.Ctor = FakeMail; FakeMail.calls = []; try { await fn(); } finally { mailApi.mailClient.Ctor = prev; if (old === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = old; } };
const dump = (w: W) => JSON.stringify([w.row.error, [...w.steps.values()].map((s: any) => [s.node_id, s.status, s.error])]);

describe('password reset template on the real engine (doubles)', () => {
  it('whole-template editor simulation fails safely on its incomplete proposal projection, without any account/task/branch/mail effect', async () => withMail(async () => {
    const w = await settle(world({ test: true }));
    assert.equal(w.row.status, 'failed', dump(w));
    assert.match(w.row.error, /no key.*subject/, 'simulation output-shape gap remains explicit, not reported as completion');
    assert.deepEqual(w.calls, []); assert.equal(w.row.branch, null);
    assert.equal(w.state.tasks.size, 0); assert.deepEqual(w.state.blocks, []);
    assert.deepEqual(w.state.passwords, []); assert.equal(w.state.fa, null);
    assert.equal(FakeMail.calls.length, 0);
  }));
  it('each reset-path effect block independently refuses real effects under test:true, even if runtime config says Real', async () => withMail(async () => {
    const effects: string[] = [];
    const deny = new Proxy({}, { get: (_t, key) => () => { effects.push(String(key)); throw new Error('unexpected real effect'); } });
    const configs: Record<string, any> = {
      'lyam-propose-password-reset': { subject: 'bao', hours: '24', title: 'Fictional' },
      'lyam-block-account': { subject: 'bao', kind: 'suspended' },
      'lyam-generate-password': {},
      'lyam-apply-password-reset': { subject: 'bao', hours: '24', approvalTaskId: 'fictional', passwordRef: 'fictional' },
      'lyam-publish-workspace': { resetApprovalTaskId: 'fictional', resetSubject: 'bao', resetHours: '24', resetRevision: 'fictional' },
      'lyam-send-secret-mail': { to: 'bao@example.test', subject: 'Fictional', account: 'bao' },
      'lyam-unblock-account': { subject: 'bao', kind: 'suspended' },
    };
    for (const [type, config] of Object.entries(configs)) {
      await _eb(type)!.run({ config: { ...config, executionMode: 'real', realConfirmed: true }, test: true, dryRun: false, log() {}, tasks: deny, accounts: deny, authn: deny, workspace: deny, secrets: deny, setTemporaryPassword: deny, branchWrite: deny, markEffectPending: deny } as any);
    }
    assert.deepEqual(effects, []); assert.equal(FakeMail.calls.length, 0);
  }));
  it('reset blocks do not admit client execution-mode override fields', () => {
    const nodes = tpl().nodes.map((n: any) => n.type === 'lyam-propose-password-reset' ? { ...n, config: { ...n.config, subject: 'bao', executionMode: 'real', realConfirmed: true } } : n);
    assert.throws(() => validateGraph({ nodes, edges: tpl().edges }), /unknown config key/);
  });
  it('nominal: waits for the approval, resumes on a RESTARTED engine, then block > set > publish > mail > unblock; the password reaches only the user service and the mail', async () => withMail(async () => {
    const w = await settle(world());
    assert.equal(w.row.status, 'waiting', dump(w)); assert.deepEqual(w.calls, []);
    w.approve();
    await settle(w, w.build()); // a new engine instance over the same durable state
    assert.equal(w.row.status, 'completed', dump(w));
    assert.deepEqual(w.calls, ['block', 'setTemporary', 'publish', 'unblock']);
    assert.equal(FakeMail.calls.length, 1);
    const [pw] = w.state.passwords; assert.ok(FakeMail.calls[0].payload.text.includes(pw));
    assert.equal(JSON.stringify([...w.steps.values()]).includes(pw), false);
    assert.equal(w.state.blocks.length, 0);
  }));
  it('refused: nothing is blocked, set, published or mailed', async () => withMail(async () => {
    const w = await settle(world()); w.approve('refused'); await settle(w, w.build());
    assert.equal(w.row.status, 'failed', dump(w)); assert.deepEqual(w.calls, []); assert.equal(FakeMail.calls.length, 0);
  }));
  it('target promoted to administrator before the approval is consumed: refused, nothing blocked or set', async () => withMail(async () => {
    const w = await settle(world()); w.approve(); w.state.isAdmin = true; await settle(w, w.build());
    assert.equal(w.row.status, 'failed', dump(w)); assert.deepEqual(w.calls, []); assert.equal(FakeMail.calls.length, 0);
  }));
  it('target promoted between apply and publication: the publication is refused BEFORE the merge, nothing published, no mail (the account stays blocked until an administrator acts)', async () => withMail(async () => {
    const w = world({ onSet: () => { w.state.isAdmin = true; } });
    await settle(w); w.approve(); await settle(w, w.build());
    assert.equal(w.row.status, 'failed', dump(w));
    assert.deepEqual(w.calls, ['block', 'setTemporary']);
    assert.equal(FakeMail.calls.length, 0);
    assert.equal(w.state.blocks.length, 1);
  }));
  it('the publication guard needs approval, account and validity together, and the generic publish is unchanged', () => {
    const { externalBlock } = loadBlocks();
    assert.throws(() => externalBlock('lyam-publish-workspace')!.validate({ resetApprovalTaskId: 't' } as never), /together/);
    assert.deepEqual(externalBlock('lyam-publish-workspace')!.validate({} as never), {});
  });
  it('a publish WITHOUT the reset guard after an approved-reset apply in the same run is refused before the merge (fail-closed); the credential stays only on the run branch, the account stays blocked, no mail', async () => withMail(async () => {
    const w = await settle(world({ stripPublishGuard: true })); w.approve(); await settle(w, w.build());
    assert.equal(w.row.status, 'failed', dump(w));
    assert.deepEqual(w.calls, ['block', 'setTemporary'], 'no publish call, no unblock');
    assert.equal(FakeMail.calls.length, 0); assert.equal(w.state.blocks.length, 1);
    assert.match(String(w.row.error ?? JSON.stringify([...w.steps.values()].map((x: any) => x.error))), /reset guard/);
  }));
  it('apply writes the credential, then FAILS (recording error), an error link leads to a publish without guard: refused, nothing published, no mail (the rule follows the graph, not the apply status)', async () => withMail(async () => {
    const w = await settle(world({ stripPublishGuard: true, errorLinkToPublish: true, failMark: true })); w.approve(); await settle(w, w.build());
    assert.equal(w.steps.get('apply')!.status, 'failed', dump(w));
    assert.ok(w.calls.includes('setTemporary'), 'the credential was written before the failure');
    assert.equal(w.calls.includes('publish'), false, 'no merge'); assert.equal(FakeMail.calls.length, 0);
    assert.equal(w.steps.get('publish')!.status, 'failed', 'the publish step itself refused: ' + dump(w));
  }));
  it('target promoted during publication: NO mail leaves; but the credential is already published and the account stays blocked (availability gap, not closed)', async () => withMail(async () => {
    const w2 = world({ onPublish: () => { w2.state.isAdmin = true; } });
    await settle(w2); w2.approve(); await settle(w2, w2.build());
    assert.equal(w2.row.status, 'failed', dump(w2));
    assert.deepEqual(w2.calls, ['block', 'setTemporary', 'publish']);
    assert.equal(FakeMail.calls.length, 0);
    assert.equal(w2.state.blocks.length, 1, 'the block is still in force: the account stays unavailable until an administrator acts');
  }));
  it('crash while publishing (process killed): the restarted engine has lost the in-memory password, so the run fails closed: NO mail, and the password is in no persisted step', async () => withMail(async () => {
    const w = world({ hangPublish: true });
    await settle(w); w.approve();
    w.engine.kick(w.row.id);
    for (const until = Date.now() + 5000; !w.calls.includes('publish') && Date.now() < until; ) await new Promise((r) => setTimeout(r, 30));
    assert.ok(w.calls.includes('publish'));
    // The process dies here: a new engine instance, a NEW (empty) secret store, same durable state.
    const fresh = new RunSecrets();
    const pw = w.state.passwords[0];
    const restarted = w.build(fresh);
    restarted.kick(w.row.id);
    for (const until = Date.now() + 5000; !['completed', 'failed'].includes(w.row.status) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 30));
    assert.equal(FakeMail.calls.length, 0, 'no mail after the restart: ' + dump(w));
    assert.equal(JSON.stringify([...w.steps.values()]).includes(pw), false);
    assert.equal(w.row.status, 'failed', dump(w));
    assert.equal(w.state.passwords.length, 1, 'the credential was not set a second time');
  }));
});
