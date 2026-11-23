import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock, validateGraph, substituteEventPayload } from './model.js';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { RunSecrets } from './run-secrets.js';
// The official "badge done" template on the REAL engine and the real blocks. Fakes: store, versioning, users, accounts, workspace, links (same contract as the meta store), the mail client.
// The two Google Sheets nodes are swapped for text-transform nodes in the engine runs (real Sheets mode always calls Google): they are covered by the structural test only.
const { createWorkflowEngine } = loadPluginModule('workflows-iga', 'engine.mjs') as any;
const mailApi = loadPluginModule('workflow-connectors', 'mail-api.mjs') as any;
class FakeMail { static hang = false; static calls: any[] = []; emails = { send: async (payload: any, opts: any) => { FakeMail.calls.push({ payload, opts }); if (FakeMail.hang) { FakeMail.hang = false; return new Promise<never>(() => {}); } return { data: { id: 'msg-1' } }; } }; }
const HOUR = 3_600_000;
const tpl = (id: string) => OFFICIAL_TEMPLATES.find((t) => t.id === id)!;

type Link = { account: string; phase1Run: string; source: string; spreadsheetId: string; sheetId: number; keyColumn: string; keyValue: string; status: 'open' | 'claimed' | 'done'; claimedRun?: string };
function linkStore() {
  const m = new Map<string, Link>(); const key = (t: string, k: any) => [t, k.connectionId, k.project, k.issueKey].join('|');
  return { m, key,
    put: async (t: string, l: any) => { const k = key(t, l); const o = m.get(k); const n = { account: l.account, phase1Run: l.runId ?? o?.phase1Run ?? 'run-a1', source: l.source, spreadsheetId: l.spreadsheetId, sheetId: l.sheetId, keyColumn: l.keyColumn, keyValue: l.keyValue }; if (o) { if (JSON.stringify({ ...o, status: undefined, claimedRun: undefined }) !== JSON.stringify({ ...n, status: undefined, claimedRun: undefined })) throw new Error('conflict'); return; } m.set(k, { ...n, status: 'open' }); },
    peek: async (t: string, k: any, runId: string) => { const o = m.get(key(t, k)); if (!o || !(o.status === 'open' || (o.status === 'claimed' && o.claimedRun === runId))) return null; return { account: o.account, phase1Run: o.phase1Run, source: o.source, spreadsheetId: o.spreadsheetId, sheetId: o.sheetId, keyColumn: o.keyColumn, keyValue: o.keyValue }; },
    claim: async (t: string, k: any, runId: string) => { const o = m.get(key(t, k)); if (!o || !(o.status === 'open' || (o.status === 'claimed' && o.claimedRun === runId))) return null; o.status = 'claimed'; o.claimedRun = runId; return { account: o.account, phase1Run: o.phase1Run, source: o.source, spreadsheetId: o.spreadsheetId, sheetId: o.sheetId, keyColumn: o.keyColumn, keyValue: o.keyValue }; },
    complete: async (t: string, k: any, runId: string) => { const o = m.get(key(t, k)); if (!o || o.status !== 'claimed' || o.claimedRun !== runId) return false; o.status = 'done'; return true; },
  };
}

function phase2Graph(rows: string) {
  const t = tpl('badge-done-temporary-password');
  const nodes = t.nodes.map((n: any) => n.id === 'find' ? { ...n, type: 'text-transform', config: { operation: 'lower', text: rows } }
    : n.id === 'mark' ? { ...n, type: 'text-transform', config: { operation: 'lower', text: 'x' } }
    : n.id === 'one' ? { ...n, config: { ...n.config, left: '{{steps.find.value}}' } } : n);
  return { nodes, edges: t.edges };
}

function world(opts: { templateMail?: boolean; templateChanged?:boolean; hang?: 'publish' | 'mail' | 'unblock'; head2?: string; rows?: string; link?: boolean; blocked?: boolean; account?: string; runId?: string; links?: ReturnType<typeof linkStore>; secrets?: RunSecrets; blocks?: { kind: string; setBy: string }[]; blockAtUnblock?: boolean; preflight?: () => Promise<void>; settingsFor?: () => Promise<any>; graph?: (g: any) => void; onClaim?: () => void; onGenerate?: () => void; onSet?: () => void; beforePublishCheck?: () => void; onPublish?: () => void; connectionFor?: () => Promise<any> } = {}) {
  const links = opts.links ?? linkStore(); const calls: string[] = []; const secrets = opts.secrets ?? new RunSecrets();
  const runId = opts.runId ?? 'run-b1';
  if (opts.link !== false && !opts.links) links.m.set(links.key('acme', { connectionId: 'jira-demo', project: 'KAN', issueKey: 'KAN-7' }), { account: opts.account ?? 'bao', phase1Run: 'run-a1', source: 'google', spreadsheetId: 'sheet-1', sheetId: 0, keyColumn: 'email', keyValue: 'bao@example.test', status: 'open' });
  const input = structuredClone(phase2Graph(opts.rows ?? '1'));
  if(opts.templateMail) {const n=input.nodes.find((n:any)=>n.id==='mail')!;const c:any=n.config;n.type='lyam-send-template-mail';n.config={to:c.to,account:c.account,hours:c.hours,revision:c.revision,sourceHead:c.sourceHead,ownerRun:c.ownerRun,templateKey:'custom.badge',templateRevision:'a'.repeat(64),param_password:c.passwordRef,param_expiry:'derived'} as any;}
  opts.graph?.(input);
  const { graph: g0, order } = validateGraph(input);
  const graph = substituteEventPayload(g0, { key: 'KAN-7', summary: 'Badge someone-else', status: 'Done', updated: 'x' });
  const row: any = { id: runId, tenant: 'acme', definition_id: 'wf-done', name: 't', graph, branch: null, base_branch: null, status: 'queued', error: null, started_by: 'jira', started_at: 'now', finished_at: null, test: false };
  const steps = new Map<string, any>(); for (const id of order) steps.set(id, { run_id: runId, node_id: id, status: 'pending', simulated: false, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null });
  const store = { getRunById: async (id: string) => (id === runId ? row : null), updateRun: async (_i: string, p: any) => { Object.assign(row, p); }, transitionRun: async (_i: string, p: any, from: string[]) => { if (!from.includes(row.status as string)) return false; Object.assign(row, p); return true; }, runningRuns: async () => (row.status === 'running' ? [row] : []), step: async (_r: string, n: string) => steps.get(n) ?? null, steps: async () => [...steps.values()], patchStep: async (_r: string, n: string, p: any) => { Object.assign(steps.get(n), p); if (n === 'gen' && p.status === 'done') opts.onGenerate?.(); } };
  const state = { email: 'bao@example.test', fa: null as any, blocks: opts.blocks ?? (opts.blocked === false ? [] : [{ kind: 'suspended', setBy: 'workflow:run-a1' }]), loginEnabled: false, passwords: [] as string[], hung: '' as string, headCalls: 0, publishHeads: [] as string[] };
  const hangNow = (what: string) => { state.hung = what; return new Promise<never>(() => {}); };
  const HEAD = 'abcdef0123456789', MAIN = 'main000111222333';
  const deps = {
    reads: { workflowMailTemplate:async()=>({revision:opts.templateChanged?'b'.repeat(64):'a'.repeat(64),variables:[{name:'password',type:'temporary-password',required:true},{name:'expiry',type:'text',required:true}],effective:{subject:'Access',text:'{{password}} until {{expiry}}'}}),renderWorkflowMail:async(_t:any,_r:any,_k:any,_rev:any,data:any)=>({subject:'Access',text:data.password+' until '+data.expiry}) },
    store, secrets, log: { warn() {}, error() {} },
    versioning: { createBranch: async () => ({}), writeOn: async (_b: string, fn: any) => fn({ query: async (sql: string, args: any[]) => { if (sql.includes('information_schema.columns')) return [[{ column_name: 'login_enabled' }]]; if (sql.startsWith('update identities set login_enabled')) { state.loginEnabled = !!args[0]; calls.push('enable'); return [{ affectedRows: 1 }]; } if (sql.includes('dolt_status')) return [[{ n: 0 }]]; return [[]]; } }), defaultBranch: 'main' },
    authorOf: (a: string) => a, branchRun: async (_b: string, fn: any) => fn(),
    settingsFor: opts.settingsFor ?? (async () => ({ mailAllowedRecipients: 'bao@example.test' })),
    connectionFor: opts.connectionFor,
    links: { put: links.put, peek: links.peek, claim: async (t: string, k: any, r: string) => { calls.push('claim'); const result = await links.claim(t, k, r); opts.onClaim?.(); return result; }, complete: async (t: string, k: any, r: string) => { calls.push('complete'); return links.complete(t, k, r); } },
    users: {
      setTemporary: async (_t: string, a: any) => { calls.push('setTemporary'); state.passwords.push(a.password); state.fa = { required: true, expired: false, revision: 'rev-1', expiresAt: Date.now() + a.hours * HOUR }; opts.onSet?.(); return { revision: 'rev-1', expiresAt: state.fa.expiresAt }; },
      firstAccess: async () => state.fa, emailOf: async () => state.email,
    },
    accounts: {
      activeBlocks: async () => state.blocks.map((b) => ({ kind: b.kind, setBy: b.setBy })),
      unblock: async (_t: string, a: any) => {
        calls.push('unblock');
        const own = a.ownerRun ? `workflow:${a.ownerRun}` : null;
        const lift = state.blocks.filter((b) => (!a.kind || b.kind === a.kind) && (!own || b.setBy === own));
        state.blocks = state.blocks.filter((b) => !lift.includes(b));
        if (opts.blockAtUnblock) state.blocks.push({ kind: 'locked', setBy: 'admin:boss' });
        if (opts.hang === 'unblock' && !state.hung) return hangNow('unblock');
        return { lifted: lift.length, remaining: state.blocks.length };
      },
    },
    workspace: { preflight: opts.preflight ?? (async () => undefined), headOf: async () => (state.headCalls++ === 0 ? HEAD : (opts.head2 ?? HEAD)), publish: async (_t: string, a: any) => { opts.beforePublishCheck?.(); await a.precheck?.(); calls.push('publish'); opts.onPublish?.(); state.publishHeads.push(a.expectedHead); if (opts.hang === 'publish' && !state.hung) return hangNow('publish'); return { published: true, branch: a.branch, sourceHead: a.expectedHead, mainCommit: MAIN, activation: 'applied' }; }, proof: async () => ({ mainCommit: MAIN, activation: 'applied', activationCommit: MAIN, containsHead: true }) },
  };
  const build = (sec: RunSecrets) => createWorkflowEngine({ ...deps, secrets: sec });
  return { row, steps, calls, state, links, secrets, engine: build(secrets), build };
}
async function settle(w: ReturnType<typeof world>) { w.engine.kick(w.row.id); for (const until = Date.now() + 10000; ; ) { if (['completed', 'failed', 'canceled'].includes(w.row.status)) return w; if (Date.now() > until) throw new Error('no settle ' + w.row.status); await new Promise((r) => setTimeout(r, 30)); } }
const withMail = async (fn: () => Promise<void>) => { const old = process.env.RESEND_API_KEY; process.env.RESEND_API_KEY = 'test-key-not-real'; const prev = mailApi.mailClient.Ctor; mailApi.mailClient.Ctor = FakeMail; FakeMail.calls = []; FakeMail.hang = false; try { await fn(); } finally { mailApi.mailClient.Ctor = prev; if (old === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = old; } };

describe('badge templates: structure', () => {
  it('both official templates validate and phase 2 keeps the required order, with the stop branch before any secret', () => {
    for (const id of ['badge-request-from-sheet', 'badge-done-temporary-password']) { const t = tpl(id); assert.ok(t, id); validateGraph({ nodes: t.nodes, edges: t.edges }); }
    const { order } = validateGraph({ nodes: tpl('badge-done-temporary-password').nodes, edges: tpl('badge-done-temporary-password').edges });
    const at = (id: string) => order.indexOf(id);
    assert.ok(at('resolve') < at('find') && at('find') < at('one') && at('one') < at('gen'));
    assert.ok(at('gen') < at('set') && at('set') < at('enable') && at('enable') < at('publish') && at('publish') < at('mail') && at('mail') < at('unblock') && at('unblock') < at('mark') && at('mark') < at('done'));
    const e = tpl('badge-done-temporary-password').edges; assert.ok(e.some((x: any) => x.from === 'one' && x.to === 'stop' && x.label === 'false'));
  });
  it('login enablement is explicit, versioned, and validation survives a graph round trip', () => {
    const node = tpl('badge-done-temporary-password').nodes.find(n => n.id === 'enable')!;
    assert.equal(node.type, 'lyam-set-login-enabled');
    assert.deepEqual(node.config, { id: '{{steps.resolve.account}}', enabled: 'yes' });
    const b = externalBlock(node.type)!;
    for (const enabled of ['yes', 'no']) {
      const once = b.validate({ id: 'fictional.badge', enabled });
      assert.deepEqual(b.validate(once), once);
      assert.equal(once.enabled, enabled === 'yes');
    }
  });
  it('phase 1 creates, publishes and blocks the account before the ticket, and records the link before marking the row', () => {
    const { order } = validateGraph({ nodes: tpl('badge-request-from-sheet').nodes, edges: tpl('badge-request-from-sheet').edges }); const at = (id: string) => order.indexOf(id);
    assert.ok(at('create') < at('publish') && at('publish') < at('block') && at('block') < at('ticket') && at('ticket') < at('link') && at('link') < at('mark'));
  });
  it('block ownership binds the two phases: phase 1 refuses a foreign block, phase 2 lifts only the creation run block and mails only when it is the sole block', () => {
    const p1 = tpl('badge-request-from-sheet').nodes.find((n: any) => n.id === 'block')!.config;
    assert.equal(p1.exclusive, 'yes', 'a suspension this run did not set fails the run instead of being reused');
    const p2 = tpl('badge-done-temporary-password').nodes;
    assert.equal(p2.find((n: any) => n.id === 'unblock')!.config.ownerRun, '{{steps.resolve.phase1Run}}');
    assert.equal(p2.find((n: any) => n.id === 'mail')!.config.ownerRun, '{{steps.resolve.phase1Run}}');
  });
  it('the Jira text is never an input of the account, the row or the recipient', () => {
    const txt = JSON.stringify(tpl('badge-done-temporary-password').nodes);
    assert.equal(/event\.summary/.test(txt), false);
    for (const k of ['subject', 'account', 'to']) assert.ok(!new RegExp(`"${k}":"[^"]*event\\.`).test(txt));
  });
});

describe('badge done: early feasibility and late revocation', () => {
  it('a graph truncated to omit secret-mail is a generic path, not a badge delivery guarantee', async () => withMail(async () => {
    let preflights = 0;
    const w = world({ settingsFor: async () => ({}), preflight: async () => { preflights++; throw Error('fixture refusal'); }, graph: (g: any) => {
      g.nodes = g.nodes.filter((n: any) => n.id !== 'mail');
      g.edges = g.edges.filter((e: any) => e.from !== 'mail' && e.to !== 'mail');
      g.edges.push({ from: 'publish', to: 'unblock' });
    } });
    await settle(w);
    assert.equal(w.row.status, 'completed'); assert.equal(preflights, 0);
    assert.equal(w.state.passwords.length, 1); assert.ok(w.calls.includes('publish')); assert.ok(w.calls.includes('unblock')); assert.equal(FakeMail.calls.length, 0);
  }));
  const noEffects = async (opts: Parameters<typeof world>[0]) => {
    const w = await settle(world(opts));
    assert.equal(w.row.status, 'failed', JSON.stringify([w.row.error, [...w.steps.values()].map(x => [x.node_id, x.error])]));
    assert.deepEqual(w.calls, []); assert.equal(w.secrets.valuesOf(w.row.id).length, 0);
    assert.equal(FakeMail.calls.length, 0); assert.equal([...w.links.m.values()][0].status, 'open');
    return w;
  };
  it('missing API key refuses before claim or password generation', async () => withMail(async () => {
    delete process.env.RESEND_API_KEY; await noEffects({});
  }));
  for (const [name, opts] of [
    ['missing current-main allowlist', { settingsFor: async () => ({}) }],
    ['unreadable current-main policy', { settingsFor: async () => { throw Error('fixture policy unavailable'); } }],
    ['malformed sender', { settingsFor: async () => ({ mailAllowedRecipients: 'bao@example.test', mailFrom: 'bad\r\nfrom@example.test' }) }],
    ['publication gate', { preflight: async () => { throw Error('fixture publication refused'); } }],
    ['different recipient', { graph: (g: any) => { g.nodes.find((n: any) => n.id === 'mail').config.to = 'elsewhere@example.test'; } }],
    ['different temporary target', { graph: (g: any) => { g.nodes.find((n: any) => n.id === 'set').config.subject = 'elsewhere'; } }],
    ['different validity', { graph: (g: any) => { g.nodes.find((n: any) => n.id === 'set').config.hours = '12'; } }],
    ['unliftable owned block', { blocks: [{ kind: 'locked', setBy: 'workflow:run-a1' }] }],
  ] as [string, NonNullable<Parameters<typeof world>[0]>][]) it(`${name}: refuses with open correlation and no effects`, async () => withMail(async () => { await noEffects(opts); }));
  it('an unavailable real managed connection is checked before the correlation is claimed', async () => withMail(async () => {
    let resolved = 0;
    await noEffects({ graph: g => { const n = g.nodes.find((x: any) => x.id === 'find'); Object.assign(n, structuredClone(tpl('badge-done-temporary-password').nodes.find((x: any) => x.id === 'find'))); Object.assign(n.config, { executionMode: 'real', realConfirmed: true, connectionId: 'sheets-demo' }); }, connectionFor: async () => { resolved++; throw Error('fixture connection unavailable'); } });
    assert.equal(resolved, 1);
  }));
  it('a changed block between peek and claim is re-read before any secret is generated', async () => withMail(async () => {
    const w = world({ onClaim: () => w.state.blocks.push({ kind: 'locked', setBy: 'admin:other' }) }); await settle(w);
    assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim']); assert.equal(w.secrets.valuesOf(w.row.id).length, 0); assert.equal(FakeMail.calls.length, 0);
  }));
  it('revocation immediately after resolution refuses before the temporary credential write', async () => withMail(async () => {
    let allowed = true;
    const w = world({ settingsFor: async () => ({ mailAllowedRecipients: allowed ? 'bao@example.test' : '' }), onGenerate: () => { allowed = false; } });
    await settle(w); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim']); assert.equal(w.state.passwords.length, 0); assert.equal(FakeMail.calls.length, 0);
  }));
  it('a resumed run with resolution already stored rechecks authority before the temporary write', async () => withMail(async () => {
    const w = world({ settingsFor: async () => ({}) });
    const link = [...w.links.m.values()][0]; link.status = 'claimed'; link.claimedRun = w.row.id;
    Object.assign(w.steps.get('resolve'), { status: 'done', output: { account: link.account, email: 'bao@example.test', phase1Run: link.phase1Run, source: link.source, spreadsheetId: link.spreadsheetId, sheetId: link.sheetId, keyColumn: link.keyColumn, keyValue: link.keyValue } });
    w.engine = w.build(new RunSecrets()); await settle(w);
    assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, []); assert.equal(w.state.passwords.length, 0); assert.equal(FakeMail.calls.length, 0); assert.equal(link.status, 'claimed');
  }));
  it('email or owned-block state changing after resolution is re-read before the temporary write', async () => withMail(async () => {
    for (const change of ['email','block']) {
      const w = world({ onGenerate: () => { if (change === 'email') w.state.email = 'changed@example.test'; else w.state.blocks = []; } });
      await settle(w); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim']); assert.equal(w.state.passwords.length, 0); assert.equal(FakeMail.calls.length, 0);
    }
  }));
  it('revocation after temporary write refuses publication, retaining the block and claimed link', async () => withMail(async () => {
    let allowed = true; const w = world({ settingsFor: async () => ({ mailAllowedRecipients: allowed ? 'bao@example.test' : '' }), onSet: () => { allowed = false; } });
    await settle(w); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim', 'setTemporary', 'enable']); assert.equal(FakeMail.calls.length, 0); assert.equal(w.state.blocks.length, 1); assert.equal([...w.links.m.values()][0].status, 'claimed');
  }));
  it('revocation while waiting for the publication queue is rechecked before the merge', async () => withMail(async () => {
    let allowed = true; const w = world({ settingsFor: async () => ({ mailAllowedRecipients: allowed ? 'bao@example.test' : '' }), beforePublishCheck: () => { allowed = false; } });
    await settle(w); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim', 'setTemporary', 'enable']); assert.equal(FakeMail.calls.length, 0);
  }));
  it('revocation after publication is still refused at final mail, with no unblock or completion', async () => withMail(async () => {
    let allowed = true; const w = world({ settingsFor: async () => ({ mailAllowedRecipients: allowed ? 'bao@example.test' : '' }), onPublish: () => { allowed = false; } });
    await settle(w); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, ['claim', 'setTemporary', 'enable', 'publish']); assert.equal(FakeMail.calls.length, 0); assert.equal(w.state.blocks.length, 1);
  }));
});

describe('badge done on the real engine', () => {
  it('nominal: claim, set, enable, publish, mail, unblock, mark, complete in that order; the password reaches only the user service and the mail; the link ends done', async () => withMail(async () => {
    const w = await settle(world());
    assert.equal(w.row.status, 'completed', JSON.stringify([w.row.error, [...w.steps.values()].map((s: any) => [s.node_id, s.status, s.error])]));
    assert.deepEqual(w.calls, ['claim', 'setTemporary', 'enable', 'publish', 'unblock', 'complete']);
    assert.equal(w.state.loginEnabled, true);
    assert.equal(FakeMail.calls.length, 1);
    const [pw] = w.state.passwords; assert.ok(FakeMail.calls[0].payload.text.includes(pw));
    assert.equal(FakeMail.calls[0].payload.to, 'bao@example.test');
    assert.equal(JSON.stringify([...w.steps.values()]).includes(pw), false);
    assert.equal([...w.links.m.values()][0].status, 'done');
  }));
  it('the account comes from the server link, not from the ticket text', async () => withMail(async () => {
    const w = await settle(world({ account: 'bao' })); assert.equal(w.steps.get('resolve')!.output.account, 'bao');
    assert.equal(w.steps.get('resolve')!.output.phase1Run, 'run-a1', 'the creation run id travels with the link');
  }));
  it('replay: a second run for the same ticket is refused at resolve; nothing generated, set, mailed or unblocked', async () => withMail(async () => {
    const first = await settle(world()); assert.equal(first.row.status, 'completed');
    const second = await settle(world({ links: first.links, runId: 'run-b2' }));
    assert.equal(second.row.status, 'failed'); assert.deepEqual(second.calls, []); assert.equal(second.secrets.valuesOf('run-b2').length, 0); assert.equal(FakeMail.calls.length, 1);
  }));
  it('no link for the ticket: refused, nothing happens', async () => withMail(async () => {
    const w = await settle(world({ link: false })); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, []); assert.equal(FakeMail.calls.length, 0);
  }));
  it('account no longer blocked: refused before any secret', async () => withMail(async () => {
    const w = await settle(world({ blocked: false })); assert.equal(w.row.status, 'failed'); assert.deepEqual(w.calls, []); assert.equal(w.secrets.valuesOf('run-b1').length, 0); assert.equal(FakeMail.calls.length, 0);
  }));
  it('a third-party block is in force: no mail, no unblock, nothing announced, every block stays', async () => withMail(async () => {
    const w = await settle(world({ blocks: [{ kind: 'suspended', setBy: 'workflow:run-a1' }, { kind: 'locked', setBy: 'admin:boss' }] }));
    assert.equal(w.row.status, 'failed', JSON.stringify([...w.steps.values()].map((x: any) => [x.node_id, x.status, x.error])));
    assert.deepEqual(w.calls, []);
    assert.equal(FakeMail.calls.length, 0, 'no mail while a block the run does not own is in force');
    assert.equal(w.state.blocks.length, 2, 'nothing was lifted');
    assert.equal([...w.links.m.values()][0].status, 'open', 'early refusal does not consume the claim');
  }));
  it('the only block in force is a pre-existing admin suspension: the mail is refused, the suspension stays', async () => withMail(async () => {
    const w = await settle(world({ blocks: [{ kind: 'suspended', setBy: 'admin:boss' }] }));
    assert.equal(w.row.status, 'failed');
    assert.equal(FakeMail.calls.length, 0);
    assert.deepEqual(w.state.blocks, [{ kind: 'suspended', setBy: 'admin:boss' }]);
  }));
  it('a block appearing after the mail: the unblock lifts only the run block, then fails closed; the third-party block stays', async () => withMail(async () => {
    const w = await settle(world({ blockAtUnblock: true }));
    assert.equal(w.row.status, 'failed', JSON.stringify([...w.steps.values()].map((x: any) => [x.node_id, x.status, x.error])));
    assert.equal(FakeMail.calls.length, 1, 'the mail left while only the owned block was in force');
    assert.deepEqual(w.state.blocks, [{ kind: 'locked', setBy: 'admin:boss' }], 'the third-party block was never lifted');
    assert.equal(w.calls.includes('complete'), false);
    assert.equal([...w.links.m.values()][0].status, 'claimed');
  }));
  it('row absent or ambiguous: stops on the stop branch before any password exists; the claim stays with this run for manual reconciliation', async () => withMail(async () => {
    for (const rows of ['0', '2']) {
      const w = await settle(world({ rows })); assert.equal(w.row.status, 'failed', `rows=${rows} ` + JSON.stringify([...w.steps.values()].map((x: any) => [x.node_id, x.status, x.error, x.output])));
      assert.deepEqual(w.calls, ['claim']); assert.equal(w.secrets.valuesOf('run-b1').length, 0); assert.equal(FakeMail.calls.length, 0);
      assert.equal([...w.links.m.values()][0].status, 'claimed');
    }
  }));
});

async function until(cond: () => boolean) { for (const t = Date.now() + 8000; !cond(); ) { if (Date.now() > t) throw new Error('condition not reached'); await new Promise((r) => setTimeout(r, 20)); } }
async function restart(w: ReturnType<typeof world>) { const e2 = w.build(new RunSecrets()); e2.resume(); for (const t = Date.now() + 10000; !['completed', 'failed', 'canceled'].includes(w.row.status) || w.row.status === 'running'; ) { if (Date.now() > t) throw new Error('no settle after restart ' + w.row.status); await new Promise((r) => setTimeout(r, 30)); } return w; }

describe('badge done: process crash and restart (the first engine is abandoned mid-call, a second one resumes from the stored state)', () => {
  it('crash during publish: the resume does NOT republish by itself; the step is marked interrupted, the run fails closed (never completed), nothing is regenerated, no mail, no unblock', async () => withMail(async () => {
    const w = world({ hang: 'publish' }); w.engine.kick(w.row.id); await until(() => w.state.hung === 'publish');
    await restart(w);
    assert.equal(w.row.status, 'failed'); assert.match(String(w.row.error), /interrupted by a restart/); assert.equal(w.steps.get('publish')!.error, 'EXTERNAL_EFFECT_REVIEW_REQUIRED');
    assert.equal(w.state.publishHeads.length, 1, 'no second publish call'); assert.equal(FakeMail.calls.length, 0);
    assert.equal(w.state.passwords.length, 1, 'set-temporary ran once and the password was not regenerated');
    assert.equal(w.calls.includes('unblock'), false); assert.equal([...w.links.m.values()][0].status, 'claimed');
    assert.equal(w.steps.get('mail')!.status, 'skipped');
  }));
  it('crash during the mail call: the resume stops for review, never resends, never unblocks, never marks the ticket done', async () => withMail(async () => {
    FakeMail.hang = true; const w = world({ hang: undefined }); w.engine.kick(w.row.id); await until(() => FakeMail.calls.length === 1);
    await restart(w);
    assert.equal(w.row.status, 'failed'); assert.match(String(w.row.error), /External effect uncertain/);
    assert.equal(FakeMail.calls.length, 1, 'no second send'); assert.equal(w.calls.includes('unblock'), false); assert.equal(w.calls.includes('complete'), false);
    assert.equal([...w.links.m.values()][0].status, 'claimed'); assert.equal(w.state.passwords.length, 1);
  }));
  it('crash during the unblock: the resume does not re-run it by itself and never reports completed; the mail is not resent; the ticket stays claimed for reconciliation', async () => withMail(async () => {
    const w = world({ hang: 'unblock' }); w.engine.kick(w.row.id); await until(() => w.state.hung === 'unblock');
    await restart(w);
    assert.equal(w.row.status, 'failed'); assert.equal(w.steps.get('unblock')!.error, 'EXTERNAL_EFFECT_REVIEW_REQUIRED'); assert.equal(FakeMail.calls.length, 1, 'the mail is not sent again');
    assert.equal(w.calls.filter((c) => c === 'unblock').length, 1); assert.equal([...w.links.m.values()][0].status, 'claimed'); assert.equal(w.steps.get('done')!.status, 'skipped');
  }));
});


describe('badge done with versioned generic template mail',()=>{
  it('preserves correlation, publication and durable acceptance before owned unblock',async()=>withMail(async()=>{const w=await settle(world({templateMail:true}));assert.equal(w.row.status,'completed',w.row.error);assert.equal(FakeMail.calls.length,1);assert.equal(w.steps.get('mail')!.output.accepted,true);assert.ok(w.calls.indexOf('publish')<w.calls.indexOf('unblock'));assert.ok(w.steps.get('mail')!.input.effectIntent.templateRevision);assert.ok(!JSON.stringify([...w.steps.values()]).includes(w.state.passwords[0]));}));
  it('phase2 preflight and final template delivery accept exact domains and recheck revocation before side effects',async()=>withMail(async()=>{
    const legacy=await settle(world({settingsFor:async()=>({mailAllowedDomains:'EXAMPLE.TEST'})}));
    assert.equal(legacy.row.status,'completed',legacy.row.error);assert.equal(FakeMail.calls.length,1);FakeMail.calls=[];
    const w=await settle(world({templateMail:true,settingsFor:async()=>({mailAllowedDomains:'EXAMPLE.TEST'})}));
    assert.equal(w.row.status,'completed',w.row.error);assert.equal(FakeMail.calls.length,1);
    let allow=true;const revoked=await settle(world({templateMail:true,settingsFor:async()=>({mailAllowedDomains:allow?'example.test':''}),onGenerate:()=>{allow=false;}}));
    assert.equal(revoked.row.status,'failed');assert.ok(!revoked.calls.includes('setTemporary'));assert.ok(!revoked.calls.includes('publish'));assert.ok(!revoked.calls.includes('unblock'));assert.equal(FakeMail.calls.length,1);
    const denied=await settle(world({templateMail:true,settingsFor:async()=>({mailAllowedDomains:'dss.name'})}));
    assert.equal(denied.row.status,'failed');assert.deepEqual(denied.calls,[]);assert.equal(FakeMail.calls.length,1);
  }));
  it('refuses stale template revision before ticket claim or credential creation',async()=>withMail(async()=>{const w=await settle(world({templateMail:true,templateChanged:true}));assert.equal(w.row.status,'failed');assert.deepEqual(w.calls,[]);assert.equal(FakeMail.calls.length,0);}));
  it('refuses a mismatched password reference before claiming or changing the credential',async()=>withMail(async()=>{const w=await settle(world({templateMail:true,graph:g=>g.nodes.find((n:any)=>n.id==='mail').config.param_password='{{steps.set.passwordRef}}'}));assert.equal(w.row.status,'failed');assert.deepEqual(w.calls,[]);assert.equal(FakeMail.calls.length,0);}));
  it('does not resend or unblock after a crash during provider acceptance',async()=>withMail(async()=>{FakeMail.hang=true;const w=world({templateMail:true});w.engine.kick(w.row.id);for(let i=0;i<200&&!FakeMail.calls.length;i++)await new Promise(r=>setTimeout(r,20));assert.equal(FakeMail.calls.length,1);assert.equal(w.steps.get('mail')!.error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');const engine=w.build(new RunSecrets());await engine.resume();await new Promise(r=>setTimeout(r,50));assert.equal(w.row.status,'failed');assert.equal(FakeMail.calls.length,1);assert.ok(!w.calls.includes('unblock'));}));
});
