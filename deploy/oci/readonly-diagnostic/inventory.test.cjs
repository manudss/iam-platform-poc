// Executes inventory.cjs against mysql2/nats DOUBLES (no real Dolt/NATS). Run: node inventory.test.cjs
globalThis.__INVENTORY_TEST__ = true;
const assert = require('node:assert/strict');
const { run, serialize } = require('./inventory.cjs');
const SENT = 'SENTINEL-SECRET-xyz-9';
const fsDouble = { readdirSync: () => ['1', '77'], readFileSync: (p) => {
  if (p === '/proc/1/cmdline') return 'sh\0start.sh'; if (p === '/proc/77/cmdline') return 'node\0dist/main';
  if (p === '/proc/77/environ') return ['DOLT_PASSWORD=' + SENT, 'DOLT_DATABASE=iam', 'IAM_CORE_NATS_URL=127.0.0.1:4222', 'IAM_CORE_NATS_PASSWORD=' + SENT, 'OTHER_SECRET=' + SENT].join('\0'); throw new Error('x'); } };
const graph = (types) => JSON.stringify({ nodes: types.map((t) => ({ type: t, name: SENT, config: { url: 'https://' + SENT, email: SENT + '@x.y' } })) });
function mysqlRich(o = {}) {
  const log = [];
  const tables = { 'iam_meta': ['workflow_runs', 'workflow_steps', 'workflow_tasks', 'workflow_piece_state', ...(o.noLinks ? [] : ['workflow_ticket_links'])], 'iam/main': ['workflow_definitions'] };
  const colsOf = { workflow_runs: ['id', 'status', 'test', 'graph'], workflow_steps: ['status', 'simulated'], workflow_tasks: ['status', 'kind'], workflow_ticket_links: ['status'], workflow_piece_state: ['value_json'], workflow_definitions: ['active', 'graph', 'trigger_json', 'name'] };
  const q = async (sql, args) => {
    log.push(sql);
    if (o.failOn && o.failOn.test(sql)) throw Object.assign(new Error(SENT), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
    if (/^SET SESSION/.test(sql)) { if (o.noRO) throw new Error('nope'); return [[]]; }
    let m = /^SHOW TABLES FROM `([^`]+)` LIKE \?/.exec(sql); if (m) return [(tables[m[1]] || []).includes(args[0]) ? [{ t: 1 }] : []];
    m = /^SHOW COLUMNS FROM `[^`]+`\.`([^`]+)`/.exec(sql); if (m) return [(colsOf[m[1]] || []).map((Field) => ({ Field }))];
    if (/GROUP BY `status`, e/.test(sql) && /workflow_runs/.test(sql)) return [[{ k: 'running', e: 0, n: 2 }, { k: 'waiting', e: 1, n: 1 }, { k: SENT, e: SENT, n: 5 }]];
    if (/workflow_tasks/.test(sql) && /GROUP BY/.test(sql)) return [[{ k: 'open', e: 'approval', n: 3 }, { k: 'open', e: SENT, n: 1 }]];
    if (/workflow_steps/.test(sql) && /GROUP BY/.test(sql)) return [[{ k: 'pending', e: 1, n: 4 }]];
    if (/workflow_ticket_links/.test(sql) && /GROUP BY/.test(sql)) return [[{ k: 'open', n: 1 }]];
    if (/COUNT\(\*\) AS n FROM `iam_meta`.workflow_piece_state/.test(sql)) return [[{ n: 7 }]];
    if (/workflow_runs WHERE status NOT IN/.test(sql)) return [[{ n: o.unexpectedStatus ? 2 : 0 }]];
    if (/FROM `iam\/main`\.`workflow_definitions`/.test(sql)) return [o.manyRows ? Array.from({ length: 2001 }, () => ({ g: graph(['lyam-send-mail']), tj: null })) : [{ g: graph(['lyam-send-mail', 'google-sheets-update', SENT]), tj: JSON.stringify({ event: SENT }) }, { g: graph(['jira-create-issue']), tj: JSON.stringify({ cron: '* * * * *' }) }, { g: null, tj: null }, { g: '{bad', tj: null }]];
    if (/WHERE status IN \('queued','running','waiting'\)/.test(sql)) return [o.bigGraph ? [{ g: graph(Array(501).fill('lyam-send-mail')), tj: null }] : [{ g: graph(['http-request', 'lyam-block-account']), tj: null }]];
    return [[]];
  };
  return { log, createConnection: async () => { if (o.connectHang) return new Promise(() => {}); return { end: async () => {}, query: q }; } };
}
function natsDouble(o = {}) {
  const subjects = [];
  return { subjects, connect: async (opts) => { assert.equal(opts.user, 'core'); return { drain: async () => {}, request: async (subj, body) => {
    subjects.push(subj); if (o.hang) return new Promise(() => {});
    const enc = (x) => ({ data: new TextEncoder().encode(JSON.stringify(x)) });
    if (subj === '$JS.API.STREAM.INFO.IAM_BUS_EVENTS') return enc({ state: o.noStreamFields ? {} : { messages: 15, consumer_count: 3 } });
    if (subj === '$JS.API.CONSUMER.LIST.IAM_BUS_EVENTS') { const off = JSON.parse(new TextDecoder().decode(body)).offset; const z = { num_pending: 0, num_ack_pending: 0, num_redelivered: 0, num_waiting: 0 }; const all = o.missingFields ? [{ name: 'directory' }, { name: 'x', ...z }, { name: 'y', ...z }] : [{ ...z, name: 'workflows-engine-base', num_pending: 2, num_ack_pending: 1 }, { ...z, name: SENT, num_pending: 4, num_redelivered: 2 }, { ...z, name: 'directory' }];
      if (o.manyPages) return enc({ total: 999, consumers: [{ name: 'x' }] }); return enc({ total: 3, consumers: all.slice(off, off + 2) }); }
    throw new Error('forbidden subject ' + subj); } }; } };
}
const mk = (my, nt, extra = {}) => ({ fs: fsDouble, mysql: () => my, nats: () => nt, emit: () => {}, ...extra });
(async () => {
  // 1. nominal: confidentiality sentinels never leak; counts folded; allowlist; complete=false because of bad/oversize graphs
  { const my = mysqlRich(), nt = natsDouble(); const o = await run(mk(my, nt)); const s = serialize(o);
    assert(!s.includes(SENT), 'sentinel leaked'); assert(!s.includes('https://')); assert(!/@x\.y/.test(s));
    assert.deepEqual(o.dolt.runs_by_status_test, { 'running|test=false': 2, 'waiting|test=true': 1, 'other|test=other': 5 });
    assert.deepEqual(o.dolt.tasks_by_status_kind, { 'open|kind=approval': 3, 'open|kind=other': 1 });
    assert.equal(o.dolt.piece_state_rows, 7);
    assert.deepEqual(o.dolt.active_definitions_main_branch.graphs_with_block_category, { mail: 1, sheets: 1, other: 1, jira: 1 });
    assert.deepEqual(o.dolt.active_definitions_main_branch.trigger_kind, { event: 1, cron: 1 });
    assert.equal(o.dolt.active_definitions_main_branch.oversize_graphs, 1); assert.equal(o.dolt.active_definitions_main_branch.unparsable_or_over_500_nodes, 1);
    assert.deepEqual(o.dolt.nonterminal_run_snapshots.graphs_with_block_category, { http: 1, 'lyam-other': 1 });
    assert.deepEqual(o.nats.consumers.by_plugin_allowlist.other, { consumers: 1, pending: 4, ack_pending: 0, redelivered: 2 });
    assert('workflows-engine-base' in o.nats.consumers.by_plugin_allowlist); assert.equal(o.nats.consumers.totals.num_pending, 6);
    assert.equal(o.complete, false);
    assert.deepEqual(nt.subjects, ['$JS.API.STREAM.INFO.IAM_BUS_EVENTS', '$JS.API.CONSUMER.LIST.IAM_BUS_EVENTS', '$JS.API.CONSUMER.LIST.IAM_BUS_EVENTS']);
    // no mutation, no checkout, correct tables and the qualified main branch
    assert(!my.log.some((q) => /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|DOLT_|CALL)\b/i.test(q) && !/^SET SESSION TRANSACTION READ ONLY$/.test(q)), 'mutating sql');
    assert(my.log.some((q) => /`iam\/main`\.`workflow_definitions`/.test(q))); assert(my.log.some((q) => /workflow_tasks/.test(q))); assert(!my.log.some((q) => /`tasks`/.test(q)));
    assert(!my.log.some((q) => /value_json/.test(q) && /^SELECT (?!COUNT)/.test(q))); }
  // 2. SQL error / permission => unknown for that block only, never absent, never fallback to meta definitions
  { const my = mysqlRich({ failOn: /workflow_tasks`? *GROUP|FROM `iam_meta`\.`workflow_tasks`/ }); const o = await run(mk(my, natsDouble())); const s = serialize(o);
    assert.deepEqual(o.dolt.tasks_by_status_kind, { unknown: 'denied' }); assert(!s.includes(SENT)); assert.equal(o.complete, false); assert.equal(o.dolt.piece_state_rows, 7);
    assert(!my.log.some((q) => /`iam_meta`\.`workflow_definitions`/.test(q))); }
  { const my = mysqlRich({ failOn: /SHOW TABLES FROM `iam\/main`/ }); const o = await run(mk(my, natsDouble())); assert.deepEqual(o.dolt.active_definitions_main_branch, { unknown: 'denied' }); }
  // 3. absent table => "absent" only when SHOW is empty
  { const o = await run(mk(mysqlRich({ noLinks: true }), natsDouble())); assert.equal(o.dolt.ticket_links_by_status, 'absent'); }
  // 4. read-only session unsupported is reported, not hidden
  { const o = await run(mk(mysqlRich({ noRO: true }), natsDouble())); assert.equal(o.dolt.read_only_session, 'unsupported'); }
  // 5. row cap
  { const o = await run(mk(mysqlRich({ manyRows: true }), natsDouble())); assert.equal(o.dolt.active_definitions_main_branch.truncated, true); assert.equal(o.dolt.active_definitions_main_branch.rows, 2000); assert.equal(o.complete, false); }
  // 6. per-source timeouts: hanging connect/NATS never hang the run, partial is marked
  { const t0 = Date.now(); const o = await run(mk(mysqlRich({ connectHang: true }), natsDouble({ hang: true }), { sourceMs: 200 })); assert(Date.now() - t0 < 3000);
    assert.equal(o.dolt.source_error, 'timeout'); assert.equal(o.nats.source_error, 'timeout'); assert.equal(o.complete, false); }
  // 7. nats pagination bound => incomplete; process not found => unknown
  { const o = await run(mk(mysqlRich(), natsDouble({ manyPages: true }))); assert.equal(o.nats.consumers.incomplete, true); assert.equal(o.complete, false); }
  { const o = await run({ ...mk(mysqlRich(), natsDouble()), fs: { readdirSync: () => ['1'], readFileSync: () => 'sh' } }); assert.equal(o.dolt.unknown, 'api_process_not_found'); assert.equal(o.complete, false); }
  // 7b. completeness: >500 nodes, unexpected run status, missing NATS numeric fields are never silently complete
  { const o = await run(mk(mysqlRich({ bigGraph: true }), natsDouble())); assert.equal(o.dolt.nonterminal_run_snapshots.unparsable_or_over_500_nodes, 1); assert.equal(o.dolt.nonterminal_run_snapshots.incomplete, true); assert.deepEqual(o.dolt.nonterminal_run_snapshots.graphs_with_block_category, {}); }
  { const o = await run(mk(mysqlRich({ unexpectedStatus: true }), natsDouble())); assert.deepEqual(o.dolt.runs_with_unexpected_status, { count: 2, incomplete: true }); assert.equal(o.complete, false); }
  { const o = await run(mk(mysqlRich(), natsDouble({ missingFields: true }))); assert.equal(o.nats.consumers.incomplete, true); assert(o.nats.consumers.missing_numeric_fields >= 4); assert.equal(o.complete, false); }
  { const o = await run(mk(mysqlRich(), natsDouble({ noStreamFields: true }))); assert.deepEqual(o.nats.stream, { unknown: 'api_error_or_fields_missing' }); assert.equal(o.complete, false); }
  // 8. output cap
  { const big = { complete: true, x: 'a'.repeat(20000) }; const s = JSON.parse(serialize(big)); assert.equal(s.truncated, true); assert.equal(s.complete, false); }
  console.log('inventory doubles: OK');
})().catch((e) => { console.error(e.stack); process.exit(1); });
