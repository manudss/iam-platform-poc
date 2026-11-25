// Read-only backlog inventory. Runs INSIDE the lyam container: docker exec -i -w /app/api lyam node - < inventory.cjs
// Direct mysql2 + nats connections; never instantiates WorkflowStore/API (its lazy init runs DDL/migrations/Dolt commits).
// Prints ONE JSON object (hard cap 16 KB) made only of fixed keys, counts, booleans and FIXED-ALLOWLIST enums:
// free text (names, ids, graph/config, urls, emails, errors, NATS names) never reaches the output; unknown values fold into "other".
// Schema source: apps/api/src/workflows/store.ts. meta DB <db>_meta: workflow_runs, workflow_steps, workflow_tasks,
// workflow_ticket_links, workflow_piece_state. Main DB branch <db>/main: workflow_definitions (has `active`).
// RunStatus = queued|running|waiting|completed|failed|canceled; task status = open|decided|canceled.
// `complete` is true only when nothing is unknown/incomplete/truncated; the workflow fails the step otherwise.
'use strict';
const PLUGIN_IDS = new Set(['app-connector','auth-digit-code','auth-digit-code-base','auth-email-otp','auth-email-otp-base','auth-password','auth-password-lockout','auth-password-policy','auth-sso-facebook','auth-sso-facebook-base','auth-sso-github','auth-sso-github-base','auth-sso-google','auth-sso-google-base','auth-sso-microsoft','auth-sso-microsoft-base','auth-sso-oidc','auth-sso-oidc-base','auth-totp','auth-totp-base','auth-webauthn','auth-webauthn-base','branding-base','connector-app-base','connector-csv-base','connector-scim-base','csv-connector','directory','examples','hr-attributes','mail-templates','mail-templates-base','mcp-gateway','mcp-gateway-base','notify-log','notify-resend','oidc-provider','org-manager','organizations','policy-studio','profile-picture','risk-geo','saml-idp','scim-connector','sso-oidc-base','sso-saml-base','workflow-connectors','workflows-engine-base','workflows-iga']);
const RUN_STATUS = ['queued', 'running', 'waiting', 'completed', 'failed', 'canceled'];
const NONTERMINAL_RUN = ['queued', 'running', 'waiting'];
const TASK_STATUS = ['open', 'decided', 'canceled'];
const TASK_KIND = ['approval', 'child-run', 'iga-close-campaign', 'iga-close-exception', 'iga-review', 'lyam-propose-password-reset', 'lyam-request-approval', 'lyam-request-publish', 'publish-approval', 'publish-merge-watch', 'reenrollment-request', 'revoke-role', 'role-assignment', 'user-access'];
const STEP_STATUS = ['pending', 'running', 'done', 'failed', 'skipped'];
const LINK_STATUS = ['open', 'claimed', 'done'];
const TIMEOUT = { source: 12000, total: 45000, query: 4000 };
const MAX_OUT = 16384, MAX_ROWS = 2000, MAX_GRAPH = 262144, MAX_GROUPS = 200, MAX_NATS_PAGES = 5;
const DB_BRANCH = 'main';
const fold = (v, allow) => (allow.includes(String(v)) ? String(v) : 'other');
const bool01 = (v) => (v === 1 || v === true || v === '1' ? 'true' : v === 0 || v === false || v === '0' ? 'false' : 'other');
function blockCategory(t) {
  t = String(t ?? '');
  if (/^google-sheets-/.test(t)) return 'sheets';
  if (/^jira-/.test(t)) return 'jira';
  if (t === 'http-request') return 'http';
  if (t === 'lyam-send-mail' || t === 'lyam-send-secret-mail') return 'mail';
  if (/^lyam-/.test(t)) return 'lyam-other';
  if (/^iga-/.test(t)) return 'iga';
  return 'other';
}
const bump = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; };
const withTimeout = (p, ms, label) => { let t; return Promise.race([p, new Promise((_, rj) => { t = setTimeout(() => rj(Object.assign(new Error(label), { code: 'TIMEOUT' })), ms); })]).finally(() => clearTimeout(t)); };
const tag = (e) => (e && e.code === 'TIMEOUT' ? 'timeout' : e && e.code === 'ER_TABLEACCESS_DENIED_ERROR' ? 'denied' : 'error');

function procEnv(fs) {
  const NEED = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'IAM_CORE_NATS_URL', 'IAM_CORE_NATS_PASSWORD'];
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (!/dist\/main/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
      const env = {};
      for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
        const i = kv.indexOf('='); if (i > 0 && NEED.includes(kv.slice(0, i))) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return env;
    } catch { /* next */ }
  }
  return null;
}

async function inventoryDolt(env, mysql, out) {
  const dbName = (env.DOLT_DATABASE || 'iam').replace(/[^A-Za-z0-9_]/g, '');
  const meta = `${dbName}_meta`, mainRef = `${dbName}/${DB_BRANCH}`;
  const c = await mysql.createConnection({ host: env.DOLT_HOST || '127.0.0.1', port: Number(env.DOLT_PORT || 3307), user: env.DOLT_USER || 'root', password: env.DOLT_PASSWORD || '', connectTimeout: 5000 });
  const d = out.dolt = {};
  const q = (sql, args) => withTimeout(c.query(sql, args), TIMEOUT.query, 'query');
  try {
    const step = async (name, fn) => { try { d[name] = await fn(); } catch (e) { d[name] = { unknown: tag(e) }; } };
    // never DOLT_CHECKOUT: only SELECT/SHOW on qualified names; read-only session is best effort and reported.
    await step('read_only_session', async () => { try { await q('SET SESSION TRANSACTION READ ONLY'); return 'true'; } catch { return 'unsupported'; } });
    // SQL errors THROW (=> unknown). Only an empty SHOW result means absent.
    const has = async (db, t) => { const [r] = await q(`SHOW TABLES FROM \`${db}\` LIKE ?`, [t]); return r.length > 0; };
    const cols = async (db, t) => { const [r] = await q(`SHOW COLUMNS FROM \`${db}\`.\`${t}\``); return new Set(r.map((x) => x.Field)); };
    const grp = (db, t, col, allow, extra, extraFn) => async () => {
      if (!(await has(db, t))) return 'absent';
      const cs = await cols(db, t); if (!cs.has(col)) return { unknown: 'column_missing' };
      const ex = extra && cs.has(extra) ? extra : null;
      const [rows] = await q(`SELECT \`${col}\` AS k${ex ? `, \`${ex}\` AS e` : ''}, COUNT(*) AS n FROM \`${db}\`.\`${t}\` GROUP BY \`${col}\`${ex ? ', e' : ''} LIMIT ${MAX_GROUPS + 1}`);
      if (rows.length > MAX_GROUPS) return { unknown: 'too_many_groups' };
      const m = {}; for (const r of rows) bump(m, `${fold(r.k, allow)}${ex ? `|${extra}=${extraFn(r.e)}` : ''}`, Number(r.n)); return m;
    };
    await step('runs_by_status_test', grp(meta, 'workflow_runs', 'status', RUN_STATUS, 'test', bool01));
    await step('steps_by_status_simulated', grp(meta, 'workflow_steps', 'status', STEP_STATUS, 'simulated', bool01));
    await step('tasks_by_status_kind', grp(meta, 'workflow_tasks', 'status', TASK_STATUS, 'kind', (k) => fold(k, TASK_KIND)));
    await step('ticket_links_by_status', grp(meta, 'workflow_ticket_links', 'status', LINK_STATUS));
    await step('piece_state_rows', async () => { if (!(await has(meta, 'workflow_piece_state'))) return 'absent'; const [r] = await q(`SELECT COUNT(*) AS n FROM \`${meta}\`.workflow_piece_state`); return Number(r[0].n); });
    const blocks = (db, t, where, needs) => async () => {
      if (!(await has(db, t))) return 'absent';
      const cs = await cols(db, t); if (!cs.has('graph') || !cs.has(needs)) return { unknown: 'column_missing' };
      const trig = cs.has('trigger_json');
      const [rows] = await q(`SELECT CASE WHEN LENGTH(graph) <= ${MAX_GRAPH} THEN graph ELSE NULL END AS g${trig ? ', trigger_json AS tj' : ''} FROM \`${db}\`.\`${t}\` ${where} LIMIT ${MAX_ROWS + 1}`);
      const truncated = rows.length > MAX_ROWS; const use = rows.slice(0, MAX_ROWS);
      const types = {}, triggers = {}; let bad = 0, oversize = 0;
      for (const r of use) {
        if (r.g === null || r.g === undefined) { oversize++; continue; }
        try {
          const g = typeof r.g === 'string' ? JSON.parse(r.g) : r.g;
          const nodes = g.nodes || []; if (!Array.isArray(nodes) || nodes.length > 500) { bad++; continue; }
          const seen = new Set(nodes.map((nd) => blockCategory(nd && nd.type))); for (const x of seen) bump(types, x);
          let kind = 'none';
          if (trig && r.tj) { const tr = typeof r.tj === 'string' ? JSON.parse(r.tj) : r.tj; kind = tr.cron ? 'cron' : tr.event ? 'event' : 'other'; }
          bump(triggers, kind);
        } catch { bad++; }
      }
      const res = { rows: use.length, truncated, oversize_graphs: oversize, unparsable_or_over_500_nodes: bad, graphs_with_block_category: types, trigger_kind: triggers, note: 'other = uncatalogued block, not proof of no effects' };
      if (truncated || oversize || bad) res.incomplete = true;
      return res;
    };
    await step('active_definitions_main_branch', blocks(mainRef, 'workflow_definitions', 'WHERE active = 1', 'active'));
    await step('nonterminal_run_snapshots', blocks(meta, 'workflow_runs', `WHERE status IN (${NONTERMINAL_RUN.map((x) => `'${x}'`).join(',')})`, 'status'));
    await step('runs_with_unexpected_status', async () => { if (!(await has(meta, 'workflow_runs'))) return 'absent'; const [r] = await q(`SELECT COUNT(*) AS n FROM \`${meta}\`.workflow_runs WHERE status NOT IN (${RUN_STATUS.map((x) => `'${x}'`).join(',')})`); const n = Number(r[0].n); return n === 0 ? 0 : { count: n, incomplete: true }; });
  } finally { await Promise.resolve(c.end()).catch(() => {}); }
}

async function inventoryNats(env, natsLib, out) {
  if (!env.IAM_CORE_NATS_URL || !env.IAM_CORE_NATS_PASSWORD) { out.nats = { unknown: 'no_core_nats_config' }; return; }
  const n = out.nats = {};
  const nc = await natsLib.connect({ servers: env.IAM_CORE_NATS_URL, user: 'core', pass: env.IAM_CORE_NATS_PASSWORD, timeout: 5000 });
  const dec = new TextDecoder(), enc = new TextEncoder();
  // ONLY these two JetStream API subjects are ever requested.
  const req = async (subj, body) => JSON.parse(dec.decode((await nc.request(subj, enc.encode(body || ''), { timeout: 5000 })).data));
  try {
    const si = await req('$JS.API.STREAM.INFO.IAM_BUS_EVENTS');
    const okn = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    n.stream = si.error || !okn(si.state?.messages) || !okn(si.state?.consumer_count) ? { unknown: 'api_error_or_fields_missing' } : { retained_messages: si.state.messages, consumer_count: si.state.consumer_count, note: 'retained is not runnable backlog' };
    const cons = []; let offset = 0, total = 0, incomplete = false;
    for (let page = 0; page < MAX_NATS_PAGES; page++) {
      const l = await req('$JS.API.CONSUMER.LIST.IAM_BUS_EVENTS', JSON.stringify({ offset }));
      if (l.error) { incomplete = true; break; }
      total = Number(l.total ?? 0) || 0; const got = l.consumers || []; cons.push(...got); offset += got.length;
      if (offset >= total || !got.length) break;
      if (page === MAX_NATS_PAGES - 1) incomplete = true;
    }
    const sum = { num_pending: 0, num_ack_pending: 0, num_redelivered: 0, num_waiting: 0 }; const per = {}; let missing = 0;
    const num = (v) => { if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v; missing++; return 0; };
    for (const x of cons) {
      for (const k of Object.keys(sum)) sum[k] += num(x[k]);
      const cat = PLUGIN_IDS.has(x.name) ? x.name : 'other';
      const e = per[cat] || (per[cat] = { consumers: 0, pending: 0, ack_pending: 0, redelivered: 0 });
      e.consumers++; e.pending += x.num_pending > 0 ? x.num_pending : 0; e.ack_pending += x.num_ack_pending > 0 ? x.num_ack_pending : 0; e.redelivered += x.num_redelivered > 0 ? x.num_redelivered : 0;
    }
    n.consumers = { listed: cons.length, total, incomplete: incomplete || cons.length < total || missing > 0, missing_numeric_fields: missing, totals: sum, by_plugin_allowlist: per };
  } finally { await Promise.resolve(nc.drain()).catch(() => {}); }
}

function isComplete(v) {
  if (v === null || typeof v !== 'object') return true;
  if (v.unknown || v.source_error || v.incomplete === true || v.truncated === true) return false;
  return Object.values(v).every(isComplete);
}
async function run(deps) {
  const out = { inventory_version: 3, dolt: {}, nats: {} };
  const env = procEnv(deps.fs);
  if (!env) { out.dolt = { unknown: 'api_process_not_found' }; out.nats = { unknown: 'api_process_not_found' }; out.complete = false; return out; }
  const emitDeadline = setTimeout(() => { out.deadline = 'exceeded'; out.complete = false; deps.emit(out); }, deps.totalMs || TIMEOUT.total);
  try {
    await withTimeout(inventoryDolt(env, deps.mysql(), out), deps.sourceMs || TIMEOUT.source, 'dolt').catch((e) => { out.dolt = { ...(out.dolt && typeof out.dolt === 'object' ? out.dolt : {}), source_error: tag(e) }; });
    await withTimeout(inventoryNats(env, deps.nats(), out), deps.sourceMs || TIMEOUT.source, 'nats').catch((e) => { out.nats = { ...(out.nats && typeof out.nats === 'object' ? out.nats : {}), source_error: tag(e) }; });
  } finally { clearTimeout(emitDeadline); }
  out.complete = isComplete(out.dolt) && isComplete(out.nats);
  return out;
}
function serialize(out) { let s = JSON.stringify(out); if (s.length > MAX_OUT) s = JSON.stringify({ inventory_version: 3, complete: false, truncated: true, bytes: s.length }); return s; }

if (typeof globalThis.__INVENTORY_TEST__ !== 'undefined') module.exports = { run, serialize, blockCategory };
else {
  const emit = (o) => { console.log(serialize(o)); process.exit(o.complete === true ? 0 : 3); };
  run({ fs: require('node:fs'), mysql: () => require('mysql2/promise'), nats: () => require('nats'), emit }).then(emit, () => emit({ inventory_version: 3, complete: false, fatal: true }));
}
