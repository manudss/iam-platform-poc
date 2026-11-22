import { safeHttp, withinConnection } from './http-transport.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runPieceAction } from './adapter.mjs';
import { serviceAccountAuth, readGoogleRows, writeGoogleRow } from './sheets-api.mjs';
import { demoSheet, DEMO_SHEET_COLUMNS } from './demo-sheet.mjs';
import { readDoneIssues } from './jira-api.mjs';
import { sendOneMail } from './mail-api.mjs';
import { LYAM_ADMIN_BLOCKS, assertResetApproval } from './lyam-admin-blocks.mjs';

/**
 * The block catalogue this plugin exposes on the `workflows.blocks` surface (SPIKE).
 * The core workflow model (plugins/workflows-iga/model.mjs) merges these descriptors into its step and
 * trigger catalogues at boot; the engine runs `block.run(ctx)` for these step types.
 *
 * Block descriptor:
 *   type        unique step type id (lowercase, digits, hyphens)
 *   family      palette group in the editor
 *   label       human name
 *   simulated   false = REAL-capable (external call or branch write); a dry-run says so in the step log
 *   category    badge shown on the node: 'simulated' (nothing really happens) | 'computed' (really runs and
 *               computes its output, no external effect) | 'real' (external call or write); default derives
 *               from `simulated` (true -> simulated, false -> real)
 *   description one honest line (what is real, what is simulated)
 *   fields      editor form: { key, label, type: string|text|number|boolean|select, required?, default?, options?, help? }
 *   outputs     documented keys usable downstream as {{steps.<id>.<key>}}
 *   validate(cfg) -> clean config (throws on invalid; unknown keys are rejected by the caller)
 *   run(ctx)    -> output object; ctx = { tenant, config, settings, log(line), dryRun, branchWrite(fn, message) }
 *
 * Trigger event descriptor (TRIGGER_EVENTS):
 *   payload ['*'] = any ASCII key of the payload may be used as {{event.<key>}}
 *   configFields  extra trigger configuration (same field shape as block fields)
 *   poll?         (config, { settings, log }) -> [{ rowNumber, values }] for watcher triggers
 */
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

const bad = (msg) => { throw new BadRequestException(msg); };
const str = (v, what, max, required = true) => {
  if (v === undefined || v === null || v === '') {
    if (required) bad(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string' || v.length > max) bad(`${what}: text up to ${max} characters`);
  return v;
};
const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 'true');

// ---- HTTP egress policy: exact host allowlist; no redirects or embedded URL credentials. ----
function guardUrl(raw, settings, checkAllowed = true) {
  let u;
  try { u = new URL(raw); } catch { bad(`http-request.url: not a URL (${raw})`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`http-request.url: http or https only (${u.protocol})`);
  const allow = String(settings?.httpAllowlist ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (u.username || u.password) bad('http-request.url: credentials in URLs are refused; use a managed connection');
  if (checkAllowed && !allow.includes(host))
    bad(`http-request: ${host} is not in the HTTP allowed hosts setting (explicit destination approval required)`);
  return u.toString();
}

const googleAuth = (settings) => {
  const serviceAccount = str(settings?.googleServiceAccount, 'google service account', 20000, false);
  if (!serviceAccount) return null;
  return serviceAccountAuth(serviceAccount, str(settings?.googleUserEmail, 'google user', 200, false));
};

// ---------------------------------------------------------------- HTTP request (Activepieces piece-http) ----
const httpRequest = {
  type: 'http-request',
  family: 'Connectors',
  label: 'HTTP request (Activepieces)',
  simulated: false,
  description: 'Real HTTPS call through a pinned public transport. Every destination host must be explicitly allow-listed. Redirects are not followed. {{event.x}} / {{steps.x.y}} placeholders OK in url, headers, body.',
  fields: [
    { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET', required: true },
    { key: 'url', label: 'URL', type: 'string', required: true, help: 'https://… (placeholders allowed)' },
    { key: 'headers', label: 'Headers (JSON object, optional)', type: 'text' },
    { key: 'body', label: 'Body (optional, JSON or raw text)', type: 'text' },
    { key: 'timeout', label: 'Timeout (seconds, max 30)', type: 'number', default: 10 },
  ],
  outputs: [
    { key: 'status', description: 'HTTP status code (0 in dry-run)' },
    { key: 'body', description: 'Response body (JSON parsed when possible, text capped at 2000 chars)' },
    { key: 'ok', description: 'true when status < 400' },
  ],
  validate(cfg) {
    const out = {
      method: str(cfg.method, 'http-request.method', 10, false) || 'GET',
      url: str(cfg.url, 'http-request.url', 500),
      headers: str(cfg.headers, 'http-request.headers', 2000, false),
      body: str(cfg.body, 'http-request.body', 4000, false),
      timeout: Math.min(30, Math.max(1, Number(cfg.timeout ?? 10) || 10)),
    };
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(out.method)) bad('http-request.method: GET, POST, PUT, PATCH or DELETE');
    if (out.headers && !out.headers.includes('{{')) {
      let headers; try { headers = JSON.parse(out.headers); } catch { bad('http-request.headers: a JSON object'); }
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string')) bad('HTTP headers must be a string-valued object');
      if (Object.keys(headers).some(k => /^(authorization|cookie|host|proxy-authorization|x-api-key)$/i.test(k))) bad('credentials must come from the managed connection');
    }
    if (!out.url.includes('{{')) guardUrl(out.url, {}, false);
    return out;
  },
  async run(ctx) {
    const c = ctx.config;
    const url = guardUrl(c.url, ctx.settings, !ctx.dryRun);
    let headers = {};
    if (c.headers) { try { headers = JSON.parse(c.headers); } catch { bad('http-request.headers: not a JSON object after substitution'); } }
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string')) bad('HTTP headers must be a string-valued object');
    if (ctx.dryRun) {
      ctx.log(`DRY-RUN: would send ${c.method} ${url}${c.body ? ` with ${c.body.length} chars of body` : ''} (nothing sent)`);
      return { status: 0, body: null, ok: true, dryRun: true };
    }
    if (ctx.settings.httpConnectionBase) {
      if (!withinConnection(ctx.settings.httpConnectionBase, url)) bad('HTTP URL is outside the selected connection');
      if (Object.keys(headers).some(k => /^(authorization|cookie|host|proxy-authorization|x-api-key)$/i.test(k))) bad('credentials must come from the managed connection');
      if (ctx.settings.httpConnectionToken) headers.Authorization = `Bearer ${ctx.settings.httpConnectionToken}`;
    }
    const result = await safeHttp(url, { method: c.method, headers, body: c.body || '', timeout: c.timeout * 1000 });
    const body = typeof result?.body === 'string' ? result.body.slice(0, 2000) : result?.body ?? null;
    ctx.log(`HTTP ${result?.status} from ${url} (real call, pinned public HTTPS transport)`);
    return { status: Number(result?.status ?? 0), body, ok: Number(result?.status ?? 500) < 400 };
  },
};

// ------------------------------------------------- Text helpers (Activepieces piece-text-helper + natives) ----
const textTransform = {
  type: 'text-transform',
  family: 'Text',
  label: 'Text transform (Activepieces)',
  simulated: true,
  category: 'computed', // really runs (real string operations, real Activepieces piece code), only no external effect
  description: 'Text helpers: concat, replace, slugify, find, split come from the Activepieces text-helper piece; lower and unaccent are native additions (the piece has none). Pure computation, no external effect.',
  fields: [
    { key: 'operation', label: 'Operation', type: 'select', options: ['concat', 'replace', 'slugify', 'find', 'split', 'lower', 'unaccent'], required: true, default: 'concat' },
    { key: 'text', label: 'Text (all but concat)', type: 'string', help: 'placeholders allowed' },
    { key: 'values', label: 'Values for concat (one per line)', type: 'text' },
    { key: 'separator', label: 'Separator (concat / split)', type: 'string', default: '' },
    { key: 'searchValue', label: 'Search (replace / find)', type: 'string' },
    { key: 'replaceValue', label: 'Replace with', type: 'string' },
  ],
  outputs: [
    { key: 'value', description: 'The resulting text (split: the items joined by \\n)' },
    { key: 'count', description: 'split: number of items' },
  ],
  validate(cfg) {
    const op = str(cfg.operation, 'text-transform.operation', 20);
    if (!['concat', 'replace', 'slugify', 'find', 'split', 'lower', 'unaccent'].includes(op)) bad(`text-transform.operation: unknown "${op}"`);
    const out = { operation: op };
    if (op === 'concat') out.values = str(cfg.values, 'text-transform.values', 2000);
    else out.text = str(cfg.text, 'text-transform.text', 2000);
    if (op === 'replace') { out.searchValue = str(cfg.searchValue, 'text-transform.searchValue', 200); out.replaceValue = str(cfg.replaceValue, 'text-transform.replaceValue', 200, false); }
    if (op === 'find') out.searchValue = str(cfg.searchValue, 'text-transform.searchValue', 200);
    if (op === 'concat' || op === 'split') out.separator = str(cfg.separator, 'text-transform.separator', 10, false);
    return out;
  },
  async run(ctx) {
    const c = ctx.config;
    switch (c.operation) {
      case 'lower': return { value: String(c.text).toLowerCase() };
      case 'unaccent': return { value: String(c.text).normalize('NFD').replace(/\p{M}/gu, '') };
      case 'concat': {
        const texts = String(c.values).split('\n').map((s) => s.trim()).filter((s) => s.length);
        const value = await runPieceAction('@activepieces/piece-text-helper', 'concat', { auth: undefined, propsValue: { texts, separator: c.separator ?? '' } });
        ctx.log(`concat of ${texts.length} values -> "${String(value).slice(0, 80)}" (Activepieces text-helper)`);
        return { value: String(value) };
      }
      case 'replace': return { value: String(await runPieceAction('@activepieces/piece-text-helper', 'replace', { auth: undefined, propsValue: { text: c.text, searchValue: c.searchValue, replaceValue: c.replaceValue ?? '', replaceOnlyFirst: false } })) };
      case 'slugify': return { value: String(await runPieceAction('@activepieces/piece-text-helper', 'slugify', { auth: undefined, propsValue: { text: c.text } })) };
      case 'find': return { value: String(await runPieceAction('@activepieces/piece-text-helper', 'find', { auth: undefined, propsValue: { text: c.text, expression: c.searchValue, ignoreCase: false } })) };
      case 'split': {
        const parts = await runPieceAction('@activepieces/piece-text-helper', 'split', { auth: undefined, propsValue: { text: c.text, delimiter: c.separator ?? '' } });
        const list = Array.isArray(parts) ? parts.map(String) : [String(parts)];
        return { value: list.join('\n'), count: list.length };
      }
    }
    bad(`text-transform: unhandled operation ${c.operation}`);
  },
};

// ----------------------------------------------------------------- Google Sheets (piece-google-sheets) ----
const sheetSourceFields = [
  { key: 'source', label: 'Source', type: 'select', options: ['demo-sheet', 'google'], default: 'demo-sheet', required: true, help: 'demo-sheet = the built-in SIMULATED sheet; google = the real API (requires a managed Google connection in Real mode)' },
  { key: 'spreadsheetId', label: 'Spreadsheet ID (google)', type: 'string' },
  { key: 'sheetId', label: 'Sheet ID, numeric (google)', type: 'number', default: 0 },
];
const sheetSource = (cfg, required = true) => {
  const source = str(cfg.source, 'source', 20, false) || 'demo-sheet';
  if (source !== 'demo-sheet' && source !== 'google') bad('source: demo-sheet or google');
  const out = { source };
  if (source === 'google') {
    out.spreadsheetId = str(cfg.spreadsheetId, 'spreadsheetId', 80, required && !String(cfg.spreadsheetId ?? '').includes('{{'));
    out.sheetId = Number(cfg.sheetId ?? 0);
    if (!Number.isInteger(out.sheetId) || out.sheetId < 0) bad('sheetId: a positive integer');
  }
  return out;
};

const sheetsRead = {
  type: 'google-sheets-read',
  family: 'Google Sheets',
  label: 'Read sheet rows (Activepieces)',
  simulated: false,
  description: 'Reads rows of a Google Sheet through the Activepieces google-sheets piece. The demo-sheet source reads the built-in SIMULATED sheet instead (no Google credential needed).',
  fields: [
    ...sheetSourceFields,
    { key: 'mode', label: 'Mode', type: 'select', options: ['all-rows', 'find-row'], default: 'all-rows', required: true },
    { key: 'columnName', label: 'Column to search (find-row)', type: 'string' },
    { key: 'searchValue', label: 'Value to find (find-row)', type: 'string' },
  ],
  outputs: [
    { key: 'rows', description: 'Matching rows as JSON (values keyed by column)' },
    { key: 'row', description: 'The first matching row (JSON) or empty' },
    { key: 'rowNumber', description: 'Sheet row number of the first match' },
    { key: 'count', description: 'Number of matching rows' },
  ],
  validate(cfg) {
    const out = { ...sheetSource(cfg), mode: str(cfg.mode, 'mode', 20, false) || 'all-rows' };
    if (out.mode !== 'all-rows' && out.mode !== 'find-row') bad('mode: all-rows or find-row');
    out.columnName = str(cfg.columnName, 'columnName', 60, out.mode === 'find-row');
    out.searchValue = str(cfg.searchValue, 'searchValue', 200, out.mode === 'find-row');
    return out;
  },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.dryRun) { ctx.log('SIMULATION: Google Sheets read, no call or sheet mutation'); return { rows: [], row: null, rowNumber: 0, count: 0, dryRun: true }; }
    if (c.source === 'demo-sheet') {
      let found = demoSheet.rows();
      if (c.mode === 'find-row') found = found.filter((r) => String(r.values[c.columnName] ?? '') === String(c.searchValue));
      const first = found[0];
      ctx.log(`read ${found.length} row(s) from the DEMO sheet (simulated source, no Google call)`);
      return { rows: found.map((r) => r.values), row: first?.values ?? null, rowNumber: first?.rowNumber ?? 0, count: found.length };
    }
    const auth = googleAuth(ctx.settings);
    if (!auth) bad('google-sheets-read: configure a managed Google Sheets connection first');
    let rows = await readGoogleRows(auth, c);
    if (c.mode === 'find-row') rows = rows.filter(r => String(r.values[c.columnName] ?? '') === c.searchValue);
    ctx.log(`Google Sheets: ${rows.length} row(s) (real API call)`);
    return { rows: rows.map(r => r.values), row: rows[0]?.values ?? null, rowNumber: rows[0]?.rowNumber ?? 0, count: rows.length };
  },
};

const sheetsUpdate = {
  type: 'google-sheets-update',
  family: 'Google Sheets',
  label: 'Update a sheet cell (Activepieces)',
  simulated: false,
  description: 'Writes one cell of one row. On the demo sheet the write updates the SIMULATED sheet; with source google it is a REAL Google Sheets write. NOT reverted by abandoning the run branch: this is an external effect.',
  fields: [
    ...sheetSourceFields,
    { key: 'rowNumber', label: 'Row number (header = row 1)', type: 'string', required: true, help: 'placeholders allowed, e.g. {{steps.read.rowNumber}} or {{event.rownumber}}' },
    { key: 'column', label: 'Column', type: 'string', required: true },
    { key: 'value', label: 'Value', type: 'string', required: true },
  ],
  outputs: [{ key: 'updated', description: 'true when the cell was written' }],
  validate(cfg) {
    return { ...sheetSource(cfg, false), rowNumber: str(cfg.rowNumber, 'rowNumber', 40), column: str(cfg.column, 'column', 60), value: str(cfg.value, 'value', 200) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.dryRun) { ctx.log('SIMULATION: Google Sheets update, no call or sheet mutation'); return { updated: false, dryRun: true }; }
    const rowNumber = Number(c.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) bad(`google-sheets-update.rowNumber: an integer >= 2 (got "${c.rowNumber}")`);
    if (c.source === 'demo-sheet') {
      demoSheet.updateCell(rowNumber, c.column, c.value);
      ctx.log(`DEMO sheet: row ${rowNumber}, column "${c.column}" <- "${c.value}" (simulated sheet, no Google call)`);
      return { updated: true };
    }
    const auth = googleAuth(ctx.settings);
    if (!auth) bad('google-sheets-update: configure a managed Google Sheets connection first');
    await writeGoogleRow(auth, c, { [c.column]: c.value }, rowNumber);
    ctx.log(`Google Sheets: row ${rowNumber}, column "${c.column}" <- "${c.value}" (REAL external write, not reverted by the run branch)`);
    return { updated: true };
  },
};

const sheetsAddRow = {
  type: 'google-sheets-add-row',
  family: 'Google Sheets',
  label: 'Append a sheet row (Activepieces)',
  simulated: false,
  description: 'Appends one row. On the demo sheet the append is SIMULATED; with source google it is a REAL append. NOT idempotent: a retried step appends another row (the piece says so itself) - the engine retry only re-runs a FAILED step, and a done step is never re-run.',
  fields: [
    ...sheetSourceFields,
    { key: 'values', label: 'Row values (one "column = value" per line)', type: 'text', required: true, help: 'placeholders allowed; unknown columns are refused' },
  ],
  outputs: [{ key: 'rowNumber', description: 'The appended row number' }],
  validate(cfg) {
    const out = { ...sheetSource(cfg, false), values: str(cfg.values, 'values', 2000) };
    return out;
  },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.dryRun) { ctx.log('SIMULATION: Google Sheets append, no call or sheet mutation'); return { rowNumber: 0, dryRun: true }; }
    const values = {};
    for (const line of String(c.values).split('\n')) {
      const m = /^\s*([A-Za-z][A-Za-z0-9_ ]{0,40}?)\s*=\s*(.*)$/.exec(line);
      if (!m) { if (line.trim()) bad(`google-sheets-add-row.values: "${line.trim()}" is not "column = value"`); continue; }
      values[m[1]] = m[2];
    }
    if (!Object.keys(values).length) bad('google-sheets-add-row.values: at least one "column = value" line');
    if (c.source === 'demo-sheet') {
      const added = demoSheet.addRow(values);
      ctx.log(`DEMO sheet: row ${added.rowNumber} appended (simulated sheet, no Google call)`);
      return { rowNumber: added.rowNumber };
    }
    const auth = googleAuth(ctx.settings);
    if (!auth) bad('google-sheets-add-row: configure a managed Google Sheets connection first');
    const result = await writeGoogleRow(auth, c, values);
    ctx.log(`Google Sheets: row ${result?.row ?? '?'} appended (REAL external write, not reverted by the run branch, not idempotent)`);
    return { rowNumber: Number(result?.row ?? 0) || undefined };
  },
};

// --------------------------------------------------------------------------- Jira (piece-jira-cloud) ----
const jiraCreateIssue = {
  type: 'jira-create-issue',
  family: 'Jira',
  label: 'Create a Jira issue (Activepieces)',
  simulated: false,
  description: 'Creates an issue on the configured Jira through the Activepieces jira-cloud piece. dryRun on (default) = SIMULATED, only logs the issue it would create. A real creation is an external effect: retrying the step creates ANOTHER issue, and abandoning the run branch does not delete it.',
  fields: [
    { key: 'dryRun', label: 'Dry run (no real creation)', type: 'boolean', default: true },
    { key: 'project', label: 'Project key', type: 'string', required: true, default: 'KAN' },
    { key: 'issueTypeId', label: 'Issue type ID (numeric)', type: 'string', required: true, default: '10001', help: 'Jira numeric id of the issue type (Task is often 10001 on a fresh site)' },
    { key: 'summary', label: 'Summary', type: 'string', required: true },
    { key: 'description', label: 'Description', type: 'text' },
  ],
  outputs: [
    { key: 'key', description: 'The created issue key (null in dry-run)' },
    { key: 'url', description: 'Browse URL of the created issue' },
  ],
  validate(cfg) {
    return {
      dryRun: bool(cfg.dryRun, true),
      project: str(cfg.project, 'jira project', 20),
      issueTypeId: str(cfg.issueTypeId, 'issueTypeId', 10),
      summary: str(cfg.summary, 'summary', 200),
      description: str(cfg.description, 'description', 2000, false),
    };
  },
  async run(ctx) {
    const c = ctx.config;
    if (c.dryRun || ctx.dryRun) {
      ctx.log(`DRY-RUN: would create Jira issue "${c.summary}" in project ${c.project} (nothing created; set dryRun off + Jira settings for a real ticket)`);
      return { key: null, url: null, dryRun: true };
    }
    const instanceUrl = str(ctx.settings?.jiraInstanceUrl, 'jira instance URL', 200, false);
    const email = str(ctx.settings?.jiraEmail, 'jira email', 200, false);
    const apiToken = str(ctx.settings?.jiraApiToken, 'jira api token', 500, false);
    if (!instanceUrl || !email || !apiToken) bad('jira-create-issue: fill the Jira settings of the workflow-connectors plugin first (console), or keep dryRun on');
    const result = await runPieceAction('@activepieces/piece-jira-cloud', 'create_issue', {
      auth: { props: { instanceUrl, email, apiToken } },
      propsValue: { projectId: c.project, issueTypeId: c.issueTypeId, issueFields: { summary: c.summary, ...(c.description ? { description: c.description } : {}) } },
    });
    const key = String(result?.key ?? '');
    ctx.log(`Jira issue ${key} created (REAL, on ${instanceUrl})`);
    // The browsable site: the connection's site URL (needed when instanceUrl is a gateway), else the site origin itself.
    const site = String(ctx.settings?.jiraSiteUrl || (/^https:\/\/[a-z0-9-]+\.atlassian\.net\/?$/i.test(instanceUrl) ? instanceUrl : '')).replace(/\/$/, '');
    return { key, url: key && site ? `${site}/browse/${key}` : null };
  },
};

const jiraSearchIssues = {
  type: 'jira-search-issues',
  family: 'Jira',
  label: 'Search Jira issues (Activepieces)',
  simulated: false,
  description: 'Runs a JQL search through the Activepieces jira-cloud piece (read-only, idempotent). dryRun on (default) = SIMULATED, only logs the query. Needs the Jira settings for a real search.',
  fields: [
    { key: 'dryRun', label: 'Dry run (no real search)', type: 'boolean', default: true },
    { key: 'jql', label: 'JQL query', type: 'text', required: true, help: "e.g. project = KAN AND status = 'To Do'" },
    { key: 'maxResults', label: 'Max results (1-100)', type: 'number', default: 10 },
  ],
  outputs: [
    { key: 'count', description: 'Number of matching issues (0 in dry-run)' },
    { key: 'issues', description: 'The issues as JSON, capped at 2000 chars (null in dry-run)' },
    { key: 'firstKey', description: 'Key of the first match (null when none or dry-run)' },
  ],
  validate(cfg) {
    const max = Math.min(100, Math.max(1, Number(cfg.maxResults ?? 10) || 10));
    return { dryRun: bool(cfg.dryRun, true), jql: str(cfg.jql, 'jql', 500), maxResults: max };
  },
  async run(ctx) {
    const c = ctx.config;
    if (c.dryRun || ctx.dryRun) {
      ctx.log(`DRY-RUN: would search Jira with JQL "${c.jql}" (max ${c.maxResults}, nothing called)`);
      return { count: 0, issues: null, firstKey: null, dryRun: true };
    }
    const instanceUrl = str(ctx.settings?.jiraInstanceUrl, 'jira instance URL', 200, false);
    const email = str(ctx.settings?.jiraEmail, 'jira email', 200, false);
    const apiToken = str(ctx.settings?.jiraApiToken, 'jira api token', 500, false);
    if (!instanceUrl || !email || !apiToken) bad('jira-search-issues: fill the Jira settings of the workflow-connectors plugin first (console), or keep dryRun on');
    const result = await runPieceAction('@activepieces/piece-jira-cloud', 'search_issues', {
      auth: { props: { instanceUrl, email, apiToken } },
      propsValue: { jql: c.jql, maxResults: c.maxResults, mapNames: true, sanitizeJql: true },
    });
    const issues = Array.isArray(result?.issues) ? result.issues : Array.isArray(result) ? result : [];
    ctx.log(`Jira search: ${issues.length} issue(s) (real API call, read-only)`);
    return { count: issues.length, issues: JSON.stringify(issues).slice(0, 2000), firstKey: issues[0]?.key ?? null };
  },
};

// ------------------------------------------------------------------- lyam connector: create a user ----
const lyamCreateUser = {
  type: 'lyam-create-user',
  family: 'lyam',
  label: 'Create the user in lyam',
  simulated: false,
  description: 'REAL data write on the run branch only: inserts the identity (login disabled until reviewed). Publishing to main stays the human review/merge.',
  fields: [
    { key: 'identity', label: 'User id', type: 'string', required: true, help: 'lowercase, digits, dots, hyphens (placeholders allowed)' },
    { key: 'displayName', label: 'Display name', type: 'string', required: true },
    { key: 'email', label: 'E-mail', type: 'string' },
    { key: 'department', label: 'Department', type: 'string' },
  ],
  outputs: [
    { key: 'identity', description: 'The created user id' },
    { key: 'email', description: 'The recorded e-mail' },
  ],
  validate(cfg) {
    const identity = str(cfg.identity, 'lyam-create-user.identity', 64);
    if (!/\{\{/.test(identity) && !/^[a-z0-9][a-z0-9.-]{0,31}$/.test(identity)) bad('lyam-create-user.identity: lowercase letters, digits, dots, hyphens (max 32), or placeholders');
    return { identity, displayName: str(cfg.displayName, 'displayName', 80), email: str(cfg.email, 'email', 120, false), department: str(cfg.department, 'department', 40, false) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (!/^[a-z0-9][a-z0-9.-]{0,31}$/.test(c.identity)) bad(`lyam-create-user.identity: "${c.identity}" is not a valid user id (lowercase, digits, dots, hyphens)`);
    await ctx.branchWrite(async (db) => {
      // A fresh database may lack the profile columns the users module adds lazily at boot (the
      // connectors e2e boots only the workflows module). Ensure them here with the same DDL so the
      // block does not depend on boot order; branch semantics are unchanged (committed with the run branch).
      const [cols] = await db.query('show columns from identities');
      const have = new Set(cols.map((x) => x.Field));
      if (!have.has('email')) await db.query('alter table identities add column email varchar(254) null');
      if (!have.has('login_enabled')) await db.query('alter table identities add column login_enabled boolean not null default true');
      if (!have.has('credential_revision')) await db.query('alter table identities add column credential_revision varchar(40)');
      const [existing] = await db.query('select count(*) n from identities where id = ?', [c.identity]);
      if (Number(existing[0].n)) {
        // Idempotence: a retried step does not fail on an existing user, it adopts the branch state.
        ctx.log(`user "${c.identity}" already exists on this branch: no change (idempotent retry)`);
        return;
      }
      await db.query('insert into identities (id, display_name, manager_id, department, email, login_enabled, credential_revision) values (?,?,null,?,?,false,null)', [c.identity, c.displayName, c.department || null, c.email || null]);
      ctx.log(`user "${c.identity}" (${c.displayName}) created on the run branch, login disabled until review`);
    }, `workflow: create user ${c.identity} (lyam connector)`);
    return { identity: c.identity, email: c.email || null, dataRow: { table: 'identities', pk: { id: c.identity } } };
  },
};



// ------------------------------------------------------------------- lyam connector: send a mail ----
const MAIL_RE = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,190}\.[A-Za-z]{2,}$/;
const lyamSendMail = {
  type: 'lyam-send-mail',
  family: 'lyam',
  label: 'Send a mail (Resend)',
  simulated: false,
  category: 'real',
  description: 'REAL and immediate: sends one mail through the notify.send hook (Resend when RESEND_API_KEY is set on the server). The recipient must be listed in the plugin setting "Mail block: allowed recipients" (empty refuses everything). The provider idempotency key (run, recipient, subject) makes a repeat within 24 hours return the first mail instead of sending another. The step needs the provider message id; without it the run stops for review. The id proves acceptance, not delivery. A test run only logs. Never put a secret in the text.',
  fields: [
    { key: 'to', label: 'Recipient (one address)', type: 'string', required: true, help: 'placeholders allowed; must be in the allowed recipients setting' },
    { key: 'subject', label: 'Subject', type: 'string', required: true },
    { key: 'text', label: 'Text', type: 'text', required: true, help: 'plain text, up to 4000 characters, placeholders allowed' },
  ],
  outputs: [{ key: 'to', description: 'The recipient' }, { key: 'accepted', description: 'true when the provider accepted the mail (not proof of delivery to the inbox)' }, { key: 'messageId', description: 'The provider message id' }],
  validate(cfg) {
    const to = str(cfg.to, 'lyam-send-mail.to', 200);
    if (!/\{\{/.test(to) && !MAIL_RE.test(to)) bad('lyam-send-mail.to: one e-mail address');
    return { to, subject: str(cfg.subject, 'lyam-send-mail.subject', 150), text: str(cfg.text, 'lyam-send-mail.text', 4000) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (!MAIL_RE.test(c.to)) bad('lyam-send-mail.to: one e-mail address');
    if (/[\r\n]/.test(c.subject)) bad('lyam-send-mail.subject: one line');
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would send "${c.subject}" to ${c.to} - nothing sent`); return { to: c.to, accepted: false, messageId: null }; }
    const allowed = String(ctx.settings?.mailAllowedRecipients ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(c.to.toLowerCase())) bad('lyam-send-mail: this recipient is not in the allowed recipients setting (the owner approves each address)');
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) bad('lyam-send-mail: RESEND_API_KEY is not set on the server (nothing sent)');
    const from = str(ctx.settings?.mailFrom, 'mail sender', 200, false) || 'lyam@dss.name';
    const idempotencyKey = `wf-mail/${ctx.runId}/${createHash('sha256').update(JSON.stringify([c.to.toLowerCase(), c.subject])).digest('hex').slice(0, 16)}`;
    const r = await sendOneMail({ apiKey, from, to: c.to, subject: c.subject, text: c.text, idempotencyKey });
    ctx.log(`mail accepted by the provider for ${c.to} (message id ${r.id}); acceptance is not proof of delivery to the inbox`);
    return { to: c.to, accepted: true, messageId: r.id };
  },
};

// ------------------------------------------------------------ lyam connector: account blocks and security settings ----
const KINDS = ['suspended', 'disabled', 'locked', 'pending_approval'];
const userId = (v, what) => { const x = str(v, what, 64); if (!/\{\{/.test(x) && !/^[a-z0-9][a-z0-9._@-]{0,63}$/.test(x)) bad(`${what}: not a valid user id`); return x; };

const lyamBlockAccount = {
  type: 'lyam-block-account',
  family: 'lyam',
  label: 'Block an account in lyam',
  simulated: false,
  category: 'real',
  description: 'REAL and immediate: sets an account block (the person sees your message at sign-in). Not written on the run branch, a block is operational state. A test run only logs what it would do. A person is never blocked if they are the last active administrator. Blocking again an account already blocked with the same type changes nothing.',
  fields: [
    { key: 'subject', label: 'User id', type: 'string', required: true, help: 'placeholders allowed, e.g. {{event.subject}}' },
    { key: 'kind', label: 'Block type', type: 'select', options: KINDS, default: 'suspended', required: true },
    { key: 'message', label: 'Message shown at sign-in', type: 'text', required: true, help: 'up to 300 characters, shown after the first factor succeeds' },
    { key: 'durationMinutes', label: 'Lift automatically after (minutes, optional)', type: 'number' },
    { key: 'exclusive', label: 'Refuse to reuse an existing block of this type', type: 'select', options: ['no', 'yes'], default: 'no', help: 'yes: fail when a block of this type is already in force (it belongs to someone else), so a later workflow can lift exactly the block this run set' },
  ],
  outputs: [{ key: 'subject', description: 'The blocked user id' }, { key: 'applied', description: 'true when a block was set, false when one of this type was already in force' }],
  validate(cfg) {
    const kind = str(cfg.kind, 'lyam-block-account.kind', 30);
    if (!KINDS.includes(kind)) bad(`lyam-block-account.kind: one of ${KINDS.join(', ')}`);
    const d = cfg.durationMinutes;
    if (d !== undefined && d !== null && d !== '' && !(Number.isInteger(Number(d)) && Number(d) >= 1 && Number(d) <= 525600)) bad('lyam-block-account.durationMinutes: a whole number of minutes (1 to 525600)');
    return { subject: userId(cfg.subject, 'lyam-block-account.subject'), kind, message: str(cfg.message, 'lyam-block-account.message', 300), ...(str(cfg.exclusive, 'lyam-block-account.exclusive', 3, false) === 'yes' ? { exclusive: true } : {}), ...(d ? { durationMinutes: Number(d) } : {}) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would block "${c.subject}" (${c.kind}) - nothing applied`); return { subject: c.subject, applied: false }; }
    if (!ctx.accounts) bad('lyam-block-account: account blocks are not available on this server');
    const r = await ctx.accounts.block(ctx.tenant, { runId: ctx.runId, subject: c.subject, kind: c.kind, message: c.message, ...(c.durationMinutes ? { untilSeconds: c.durationMinutes * 60 } : {}) });
    if (c.exclusive && !r.applied) bad(`lyam-block-account: the account already has a ${c.kind} block that this run did not set: not taking it over`);
    ctx.log(r.applied ? `account "${c.subject}" blocked (${c.kind})` : `account "${c.subject}" already has a ${c.kind} block in force: no change`);
    return { subject: c.subject, applied: r.applied };
  },
};

const lyamPublishWorkspace = {
  type: 'lyam-publish-workspace',
  family: 'lyam',
  label: 'Publish the run branch to main',
  simulated: false,
  category: 'real',
  description: 'REAL: merges this run\'s working branch into main and activates it, with the same checks as a human Apply (separation of duties, unreachable level, activation). Only workflows an administrator listed in the publishAllowedWorkflows setting may do it. The result is read back from the real state: it fails unless main moved to the activated commit. A test run publishes nothing. It is not a GitHub merge.',
  fields: [],
  outputs: [{ key: 'published', description: 'true only when main holds the branch and the activation is applied' }, { key: 'mainCommit', description: 'The commit of main that was activated' }, { key: 'sourceHead', description: 'The branch head that was published' }],
  validate() { return {}; },
  async run(ctx) {
    if (ctx.test || ctx.dryRun) { ctx.log('test run: nothing published'); return { published: false }; }
    if (!ctx.workspace) bad('lyam-publish-workspace: publication is not available on this server');
    if (!ctx.hasRunBranch || !ctx.publishIntent) bad('lyam-publish-workspace: this run has no working branch to publish (an earlier step must write data)');
    const r = await ctx.workspace.publish(ctx.tenant, { runId: ctx.runId, workflowId: ctx.workflowId, branch: ctx.publishIntent.branch, expectedHead: ctx.publishIntent.head });
    if (!r || r.published !== true || !r.mainCommit) bad('lyam-publish-workspace: publication not confirmed by the real state');
    ctx.log(`published ${r.branch} at ${String(r.sourceHead).slice(0, 12)}: main is now ${String(r.mainCommit).slice(0, 12)}, activation ${r.activation}`);
    return { published: true, mainCommit: r.mainCommit, sourceHead: r.sourceHead };
  },
};

const lyamUnblockAccount = {
  type: 'lyam-unblock-account',
  family: 'lyam',
  label: 'Lift the blocks of an account in lyam',
  simulated: false,
  category: 'real',
  description: 'REAL and immediate: lifts the blocks of an account (all of them, or one type). A test run only logs what it would do.',
  fields: [
    { key: 'subject', label: 'User id', type: 'string', required: true, help: 'placeholders allowed' },
    { key: 'kind', label: 'Only this type (optional)', type: 'select', options: ['', ...KINDS] },
    { key: 'ownerRun', label: 'Only blocks set by this workflow run (optional)', type: 'string', help: '{{steps.<resolve-ticket>.phase1Run}}: lifts only the block the creation run set, never an administrator or another run block. Needs a type.' },
  ],
  outputs: [{ key: 'subject', description: 'The user id' }, { key: 'lifted', description: 'How many blocks were lifted' }, { key: 'remaining', description: 'Blocks still in force after the lift' }],
  validate(cfg) {
    const kind = str(cfg.kind, 'lyam-unblock-account.kind', 30, false);
    if (kind && !KINDS.includes(kind)) bad(`lyam-unblock-account.kind: one of ${KINDS.join(', ')}`);
    const ownerRun = str(cfg.ownerRun, 'lyam-unblock-account.ownerRun', 80, false);
    if (ownerRun && !kind) bad('lyam-unblock-account.ownerRun: needs a block type');
    return { subject: userId(cfg.subject, 'lyam-unblock-account.subject'), ...(kind ? { kind } : {}), ...(ownerRun ? { ownerRun } : {}) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would lift the blocks of "${c.subject}"${c.kind ? ` (${c.kind})` : ''} - nothing applied`); return { subject: c.subject, lifted: 0 }; }
    if (!ctx.accounts) bad('lyam-unblock-account: account blocks are not available on this server');
    const r = await ctx.accounts.unblock(ctx.tenant, { runId: ctx.runId, subject: c.subject, ...(c.kind ? { kind: c.kind } : {}), ...(c.ownerRun ? { ownerRun: c.ownerRun } : {}) });
    ctx.log(`${r.lifted} block(s) lifted on "${c.subject}"${c.ownerRun ? ' (only those set by the creation run)' : ''}`);
    if (c.ownerRun && r.remaining > 0) bad('lyam-unblock-account: another block is still in force on this account: it is not available yet');
    return { subject: c.subject, lifted: r.lifted, remaining: r.remaining ?? 0 };
  },
};

const lyamSecuritySetting = {
  type: 'lyam-security-setting',
  family: 'lyam',
  label: 'Change a security setting in lyam',
  simulated: false,
  category: 'real',
  description: 'REAL data write on the run branch only: changes one account-security setting (lockout, administration level, application level, hold after verification). It goes live with the normal review and Apply. The value is checked like the settings screen checks it.',
  fields: [
    { key: 'setting', label: 'Setting', type: 'string', required: true, help: 'lockout.enabled, lockout.maxFailures, lockout.windowSeconds, lockout.lockSeconds, lockout.hold, adminMinLevel, adminMaxAgeSeconds, holdAfterVerification, or appLevel.<application id> (0 removes the rule)' },
    { key: 'value', label: 'Value', type: 'string', required: true, help: 'a whole number or true / false' },
  ],
  outputs: [{ key: 'setting', description: 'The setting changed' }, { key: 'value', description: 'The value written' }],
  validate(cfg) { return { setting: str(cfg.setting, 'lyam-security-setting.setting', 80), value: str(cfg.value, 'lyam-security-setting.value', 20) }; },
  async run(ctx) {
    const c = ctx.config;
    if (!ctx.accounts) bad('lyam-security-setting: not available on this server');
    await ctx.branchWrite(async (db) => {
      const [t] = await db.query("select count(*) n from information_schema.tables where table_schema = database() and table_name = 'plugin_runtime_settings'");
      if (!Number(t[0].n)) bad('lyam-security-setting: the settings storage does not exist on this branch');
      const [rows] = await db.query("select settings from plugin_runtime_settings where tenant = ? and plugin = 'core-security'", [ctx.tenant]);
      const raw = rows[0]?.settings;
      const current = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const next = ctx.accounts.patchSecurity(current, c.setting, c.value);
      await db.query("insert into plugin_runtime_settings (tenant, plugin, settings) values (?, 'core-security', ?) on duplicate key update settings = values(settings)", [ctx.tenant, JSON.stringify(next)]);
      ctx.log(`${c.setting} = ${c.value} written on the run branch (live after review and Apply)`);
    }, `workflow: security setting ${c.setting} (lyam connector)`);
    return { setting: c.setting, value: c.value };
  },
};

// ------------------------------------------------- lyam connector: temporary password, then the secret mail ----
const lyamGeneratePassword = {
  type: 'lyam-generate-password',
  family: 'lyam',
  label: 'Generate a temporary password',
  simulated: false,
  category: 'real',
  description: 'Creates a random password and keeps it in server memory for THIS run only. The step returns an opaque reference, never the value: only "Set as temporary password" and "Send the secret mail" of this run can use it. Nothing is written anywhere. A server restart loses it, the run then fails closed and starts again from this step.',
  fields: [],
  outputs: [{ key: 'passwordRef', description: 'Opaque reference to the password (not the password)' }],
  validate() { return {}; },
  async run(ctx) {
    if (ctx.test || ctx.dryRun) { ctx.log('test run: no password generated'); return { passwordRef: null }; }
    if (!ctx.secrets) bad('lyam-generate-password: secret handling is not available on this server');
    const ref = ctx.secrets.generate();
    ctx.log('temporary password generated and kept in memory for this run (reference only)');
    return { passwordRef: ref };
  },
};

const HOURS_RE = /^\d{1,4}(\.\d{1,2})?$/;
const hoursOf = (v, what) => { const x = String(v ?? '').trim(); if (!/\{\{/.test(x) && (!HOURS_RE.test(x) || !(Number(x) > 0 && Number(x) <= 720))) bad(`${what}: hours, more than 0 and at most 720`); return x; };
const lyamSetTemporaryPassword = {
  type: 'lyam-set-temporary-password',
  family: 'lyam',
  label: 'Set the password as temporary',
  simulated: false,
  category: 'real',
  description: 'REAL data write on the run branch only: records the generated password as a TEMPORARY one for the account (change forced at first sign-in, server-side expiry in hours). It is not active until the branch is published to main and activated. The login stays blocked until the unblock step. The password never appears in the output.',
  fields: [
    { key: 'subject', label: 'User id', type: 'string', required: true, help: 'placeholders allowed' },
    { key: 'passwordRef', label: 'Password reference', type: 'string', required: true, help: 'from the generate step, e.g. {{steps.<id>.passwordRef}}' },
    { key: 'hours', label: 'Temporary password validity (hours)', type: 'string', required: true, help: 'the real value; the mail shows the one recorded' },
  ],
  outputs: [{ key: 'subject', description: 'The user id' }, { key: 'revision', description: 'The credential revision written on the run branch' }, { key: 'expiresAt', description: 'Expiry (ms since epoch) recorded with the credential' }, { key: 'hours', description: 'The validity requested' }],
  validate(cfg) { return { subject: userId(cfg.subject, 'lyam-set-temporary-password.subject'), passwordRef: str(cfg.passwordRef, 'lyam-set-temporary-password.passwordRef', 80), hours: hoursOf(cfg.hours, 'lyam-set-temporary-password.hours') }; },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would set a temporary password for "${c.subject}" - nothing written`); return { subject: c.subject, revision: null, expiresAt: null, hours: Number(c.hours) }; }
    if (!ctx.secrets || !ctx.setTemporaryPassword) bad('lyam-set-temporary-password: not available on this server');
    if (!HOURS_RE.test(c.hours)) bad('lyam-set-temporary-password.hours: a number of hours');
    const password = ctx.secrets.reveal(c.passwordRef);
    const r = await ctx.setTemporaryPassword({ id: c.subject, password, hours: Number(c.hours) });
    if (!r?.revision || !(r.expiresAt > 0)) bad('lyam-set-temporary-password: the credential was not confirmed with its first-access rule');
    ctx.log(`temporary password recorded on the run branch for "${c.subject}" (revision ${String(r.revision).slice(0, 8)}, ${c.hours} h); not active until published`);
    return { subject: c.subject, revision: String(r.revision), expiresAt: r.expiresAt, hours: Number(c.hours) };
  },
};

/**
 * The runtime guard before any mail that carries a secret. It re-reads the REAL state (never the workflow graph) and refuses on the first mismatch: nothing is sent.
 * Checks: this run's published head is really contained in main and the live activation is applied on that main; the account holds the credential revision THIS run set, with the
 * first-access rule required, not expired, expiry not later than the parameter allows; the recipient is the e-mail recorded on that identity; the account is still blocked (the unblock comes after).
 */
export async function verifySecretMailState(ctx, c) {
  const need = (ok, why) => { if (!ok) { ctx.log(`secret mail refused: ${why}. Nothing was sent.`); bad(`lyam-send-secret-mail: ${why}`); } };
  need(ctx.workspace?.proof && ctx.users?.firstAccess && ctx.users?.emailOf && ctx.accounts?.activeBlocks, 'the real-state checks are not available on this server');
  let proof, fa, email, blocks;
  try { [proof, fa, email, blocks] = await Promise.all([ctx.workspace.proof(ctx.tenant, c.sourceHead), ctx.users.firstAccess(c.account, 'main'), ctx.users.emailOf(c.account, 'main'), ctx.accounts.activeBlocks(ctx.tenant, c.account)]); }
  catch { need(false, 'the real state could not be read'); }
  need(proof && proof.activation === 'applied' && proof.containsHead === true && proof.activationCommit && proof.activationCommit === proof.mainCommit, 'main does not hold the head published by this run with an applied activation');
  need(fa && fa.required === true && fa.expired === false, 'the account has no live first-access rule, or it expired');
  need(String(fa.revision) === String(c.revision), 'the live credential is not the one this run set');
  const ms = Number(c.hours) * 3_600_000;
  need(fa.expiresAt > Date.now() && fa.expiresAt <= Date.now() + ms + 60_000, 'the recorded expiry does not match the validity parameter');
  need(typeof email === 'string' && email.toLowerCase() === c.to.toLowerCase(), 'the recipient is not the e-mail recorded on this identity');
  need(Array.isArray(blocks) && blocks.length > 0, 'the account is not blocked any more (the unblock step comes after the mail)');
  need(blocks.every(b => b.setBy === `workflow:${c.ownerRun}`), 'a block that the creation run did not set is in force on this account: it would not be available');
  return { expiresAt: fa.expiresAt };
}

const lyamSendSecretMail = {
  type: 'lyam-send-secret-mail',
  family: 'lyam',
  label: 'Send the temporary password mail',
  simulated: false,
  category: 'real',
  description: 'REAL and immediate, non repeatable: sends the temporary password to the recipient. Before sending it re-reads the real state (this run\'s publication live on main, the credential this run set, still required and not expired, the recipient is the identity\'s own e-mail, the account still blocked) and sends nothing otherwise. The text must contain [[password]] and [[expiry]]; the expiry shown is the recorded one. One attempt: an unknown result stops the run for review, never a second send. No fallback.',
  fields: [
    { key: 'account', label: 'User id', type: 'string', required: true, help: 'placeholders allowed' },
    { key: 'to', label: 'Recipient (one address)', type: 'string', required: true, help: 'must be the e-mail of that identity and in the allowed recipients setting' },
    { key: 'subject', label: 'Subject', type: 'string', required: true },
    { key: 'text', label: 'Text', type: 'text', required: true, help: 'plain text with [[password]] and [[expiry]] (and optionally [[hours]])' },
    { key: 'passwordRef', label: 'Password reference', type: 'string', required: true },
    { key: 'hours', label: 'Validity (hours)', type: 'string', required: true, help: 'same value as the set-temporary step' },
    { key: 'revision', label: 'Credential revision', type: 'string', required: true, help: '{{steps.<set-temporary>.revision}}' },
    { key: 'sourceHead', label: 'Published head', type: 'string', required: true, help: '{{steps.<publish>.sourceHead}}' },
    { key: 'resetApprovalTaskId', label: 'Reset approval task (reset path only)', type: 'string', required: false, help: '{{steps.<propose-reset>.taskId}}: when set, the approval and the non-admin status of the account are re-checked right before the mail leaves' },
    { key: 'ownerRun', label: 'Run that set the account block', type: 'string', required: true, help: '{{steps.<resolve-ticket>.phase1Run}}: the only block allowed to be in force when the mail leaves' },
  ],
  outputs: [{ key: 'to', description: 'The recipient' }, { key: 'accepted', description: 'true when the provider accepted the mail (not proof of delivery)' }, { key: 'messageId', description: 'The provider message id' }, { key: 'expiresAt', description: 'The expiry shown in the mail' }],
  validate(cfg) {
    const to = str(cfg.to, 'lyam-send-secret-mail.to', 200);
    if (!/\{\{/.test(to) && !MAIL_RE.test(to)) bad('lyam-send-secret-mail.to: one e-mail address');
    const text = str(cfg.text, 'lyam-send-secret-mail.text', 4000);
    if (!text.includes('[[password]]') || !text.includes('[[expiry]]')) bad('lyam-send-secret-mail.text: must contain [[password]] and [[expiry]]');
    return { account: userId(cfg.account, 'lyam-send-secret-mail.account'), to, subject: str(cfg.subject, 'lyam-send-secret-mail.subject', 150), text, passwordRef: str(cfg.passwordRef, 'lyam-send-secret-mail.passwordRef', 80), hours: hoursOf(cfg.hours, 'lyam-send-secret-mail.hours'), revision: str(cfg.revision, 'lyam-send-secret-mail.revision', 80), ownerRun: str(cfg.ownerRun, 'lyam-send-secret-mail.ownerRun', 80), sourceHead: str(cfg.sourceHead, 'lyam-send-secret-mail.sourceHead', 80), ...(String(cfg.resetApprovalTaskId ?? '').trim() ? { resetApprovalTaskId: str(cfg.resetApprovalTaskId, 'lyam-send-secret-mail.resetApprovalTaskId', 80) } : {}) };
  },
  async run(ctx) {
    const c = ctx.config;
    if (!MAIL_RE.test(c.to)) bad('lyam-send-secret-mail.to: one e-mail address');
    if (/[\r\n]/.test(c.subject)) bad('lyam-send-secret-mail.subject: one line');
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would send the temporary password mail to ${c.to} - nothing sent`); return { to: c.to, accepted: false, messageId: null, expiresAt: null }; }
    if (!ctx.secrets || !ctx.markEffectPending) bad('lyam-send-secret-mail: not available on this server');
    const allowed = String(ctx.settings?.mailAllowedRecipients ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(c.to.toLowerCase())) bad('lyam-send-secret-mail: this recipient is not in the allowed recipients setting');
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) bad('lyam-send-secret-mail: RESEND_API_KEY is not set on the server (nothing sent)');
    // Reset path only: the approval and the target's non-admin status are re-checked right before the mail leaves.
    if (c.resetApprovalTaskId) await assertResetApproval(ctx, 'lyam-send-secret-mail', c.resetApprovalTaskId, c.account, c.hours);
    const { expiresAt } = await verifySecretMailState(ctx, c);
    const password = ctx.secrets.reveal(c.passwordRef);
    const body = c.text.split('[[password]]').join(password).split('[[expiry]]').join(new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC').split('[[hours]]').join(String(Number(c.hours)));
    const from = str(ctx.settings?.mailFrom, 'mail sender', 200, false) || 'lyam@dss.name';
    const idempotencyKey = `wf-secretmail/${ctx.runId}/${createHash('sha256').update(JSON.stringify([c.to.toLowerCase(), c.account, c.revision])).digest('hex').slice(0, 16)}`;
    // Durable intent first: from here a crash leaves the step in review and the run never sends a second time by itself.
    await ctx.markEffectPending({ to: createHash('sha256').update(c.to.toLowerCase()).digest('hex').slice(0, 12), account: c.account, revision: c.revision, idempotencyKey });
    const r = await sendOneMail({ apiKey, from, to: c.to, subject: c.subject, text: body, idempotencyKey });
    if (!r?.id) bad('lyam-send-secret-mail: the provider did not return a message id');
    ctx.secrets.drop(c.passwordRef);
    ctx.log(`secret mail accepted by the provider for ${c.to} (message id ${r.id}); acceptance is not proof of delivery`);
    return { to: c.to, accepted: true, messageId: r.id, expiresAt };
  },
};

// ----------------------------------------------------- ticket > account > sheet row correlation (internal, durable) ----
// The Jira summary and label are for readability only. The authority that links a Done ticket to an account and a sheet row is a record written by the creation workflow
// in the server's own store, keyed by tenant + connection + project + issue key. The row is identified by a key column and value (never trusted as a row number: sorting moves rows).
const ISSUE_RE = /^[A-Z][A-Z0-9]{1,19}-\d{1,9}$/;
const PROJECT_RE = /^[A-Z][A-Z0-9]{1,19}$/;
const CONN_RE = /^[A-Za-z0-9._-]{1,40}$/;
const ticketRef = (cfg, what) => {
  const connectionId = str(cfg.connectionId, `${what}.connectionId`, 40);
  const project = str(cfg.project, `${what}.project`, 20);
  const issueKey = str(cfg.issueKey, `${what}.issueKey`, 40);
  if (!/\{\{/.test(connectionId) && !CONN_RE.test(connectionId)) bad(`${what}.connectionId: not a valid connection id`);
  if (!/\{\{/.test(project) && !PROJECT_RE.test(project)) bad(`${what}.project: a Jira project key`);
  if (!/\{\{/.test(issueKey) && !ISSUE_RE.test(issueKey)) bad(`${what}.issueKey: a Jira issue key such as KAN-12`);
  return { connectionId, project, issueKey };
};
const ticketRefNow = (c, what) => {
  if (!CONN_RE.test(c.connectionId) || !PROJECT_RE.test(c.project) || !ISSUE_RE.test(c.issueKey)) bad(`${what}: the ticket reference is not valid (connection, project, issue key)`);
  return { connectionId: c.connectionId, project: c.project, issueKey: c.issueKey };
};
const ticketFields = [
  { key: 'connectionId', label: 'Jira connection id', type: 'string', required: true, help: 'the managed Jira connection the ticket belongs to' },
  { key: 'project', label: 'Jira project key', type: 'string', required: true, default: 'KAN' },
  { key: 'issueKey', label: 'Ticket key', type: 'string', required: true, help: '{{steps.<jira-step>.key}} when linking, {{event.key}} when resolving' },
];
const lyamLinkTicket = {
  type: 'lyam-link-ticket',
  family: 'lyam',
  label: 'Link the ticket to the account and the sheet row',
  simulated: false,
  category: 'real',
  description: 'Writes the durable correlation the "badge done" workflow later resolves: ticket key > account > sheet row identity (key column and value). Operational state in the server store, not on the run branch. The same content again is an idempotent retry; a different account or row for the same ticket is refused, never overwritten.',
  fields: [
    ...ticketFields,
    { key: 'account', label: 'User id', type: 'string', required: true, help: 'placeholders allowed' },
    ...sheetSourceFields,
    { key: 'keyColumn', label: 'Row key column', type: 'string', required: true, help: 'a column whose value is unique per person (for example email); the row is found again by it, not by its number' },
    { key: 'keyValue', label: 'Row key value', type: 'string', required: true, help: 'e.g. {{event.email}}' },
  ],
  outputs: [{ key: 'linked', description: 'true when the correlation is recorded' }],
  validate(cfg) { return { ...ticketRef(cfg, 'lyam-link-ticket'), account: userId(cfg.account, 'lyam-link-ticket.account'), ...sheetSource(cfg), keyColumn: str(cfg.keyColumn, 'lyam-link-ticket.keyColumn', 60), keyValue: str(cfg.keyValue, 'lyam-link-ticket.keyValue', 200) }; },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log('test run: would link the ticket to the account and the sheet row - nothing recorded'); return { linked: false }; }
    if (!ctx.links) bad('lyam-link-ticket: ticket links are not available on this server');
    const ref = ticketRefNow(c, 'lyam-link-ticket');
    if (!/^[a-z0-9][a-z0-9._@-]{0,63}$/.test(c.account)) bad('lyam-link-ticket.account: not a valid user id');
    if (!String(c.keyColumn).trim() || !String(c.keyValue).trim()) bad('lyam-link-ticket: the row key column and value must be filled');
    const sheetId = c.source === 'google' ? Number(c.sheetId ?? 0) : 0;
    await ctx.links.put({ ...ref, account: c.account, source: c.source, spreadsheetId: c.source === 'google' ? String(c.spreadsheetId) : 'demo-sheet', sheetId, keyColumn: String(c.keyColumn), keyValue: String(c.keyValue) });
    ctx.log(`ticket ${ref.issueKey} linked to account "${c.account}" and the row identified by ${c.keyColumn}`);
    return { linked: true };
  },
};
const lyamResolveTicket = {
  type: 'lyam-resolve-ticket',
  family: 'lyam',
  label: 'Resolve the account and the sheet row of a Done ticket',
  simulated: false,
  category: 'real',
  description: 'Looks the ticket up in the server correlation written by the creation workflow and CLAIMS it for this run (one run per ticket). Refuses, with nothing changed, when there is no link, when it was already handled or claimed by another run, when the account does not exist on main or is no longer blocked. The Jira summary is never used to choose the account or the row.',
  fields: ticketFields,
  outputs: [{ key: 'account', description: 'The linked user id' }, { key: 'phase1Run', description: 'The run that created the account and set its block (to lift exactly that block later)' }, { key: 'email', description: 'The e-mail recorded on that account on main (the only address the secret mail may use)' }, { key: 'source', description: 'demo-sheet or google' }, { key: 'spreadsheetId', description: 'Spreadsheet id (google)' }, { key: 'sheetId', description: 'Sheet id (google)' }, { key: 'keyColumn', description: 'Row key column' }, { key: 'keyValue', description: 'Row key value' }],
  validate(cfg) { return ticketRef(cfg, 'lyam-resolve-ticket'); },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log('test run: would resolve the ticket link - nothing claimed'); return { account: null, email: null, source: null, spreadsheetId: null, sheetId: null, keyColumn: null, keyValue: null }; }
    if (!ctx.links || !ctx.accounts?.activeBlocks || !ctx.users?.emailOf) bad('lyam-resolve-ticket: not available on this server');
    const ref = ticketRefNow(c, 'lyam-resolve-ticket');
    const l = await ctx.links.claim(ref);
    if (!l) { ctx.log('ticket link refused: none, already handled, or claimed by another run. Nothing changed.'); bad('lyam-resolve-ticket: no open link for this ticket (absent, already handled, or claimed by another run)'); }
    let email, blocks;
    try { [email, blocks] = await Promise.all([ctx.users.emailOf(l.account, 'main'), ctx.accounts.activeBlocks(ctx.tenant, l.account)]); } catch { bad('lyam-resolve-ticket: the account state could not be read'); }
    if (typeof email !== 'string' || !email) bad('lyam-resolve-ticket: the linked account does not exist on main (or has no e-mail)');
    if (!Array.isArray(blocks) || blocks.length === 0) bad('lyam-resolve-ticket: the linked account is not blocked: refusing to continue');
    ctx.log(`ticket ${ref.issueKey} resolved to account "${l.account}" (claimed by this run)`);
    return { account: l.account, phase1Run: l.phase1Run ?? null, email, source: l.source, spreadsheetId: l.spreadsheetId, sheetId: l.sheetId, keyColumn: l.keyColumn, keyValue: l.keyValue };
  },
};
const lyamCompleteTicket = {
  type: 'lyam-complete-ticket',
  family: 'lyam',
  label: 'Mark the ticket link as handled',
  simulated: false,
  category: 'real',
  description: 'Last step of the "badge done" workflow: marks the correlation done so the same ticket can never be processed again. Refuses when this run does not hold the claim.',
  fields: ticketFields,
  outputs: [{ key: 'completed', description: 'true when the link is marked done' }],
  validate(cfg) { return ticketRef(cfg, 'lyam-complete-ticket'); },
  async run(ctx) {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log('test run: would mark the ticket link done - nothing written'); return { completed: false }; }
    if (!ctx.links) bad('lyam-complete-ticket: not available on this server');
    if (!(await ctx.links.complete(ticketRefNow(c, 'lyam-complete-ticket')))) bad('lyam-complete-ticket: this run does not hold the claim on that ticket');
    return { completed: true };
  },
};

export const BLOCKS = [httpRequest, textTransform, sheetsRead, sheetsUpdate, sheetsAddRow, jiraCreateIssue, jiraSearchIssues, lyamCreateUser, lyamBlockAccount, lyamUnblockAccount, lyamSecuritySetting, lyamSendMail, lyamPublishWorkspace, lyamGeneratePassword, lyamSetTemporaryPassword, lyamSendSecretMail, lyamLinkTicket, lyamResolveTicket, lyamCompleteTicket, ...LYAM_ADMIN_BLOCKS];

// ----------------------------------------------------------------------------- Start triggers ----
export const TRIGGER_EVENTS = {
  'http.webhook-received': {
    label: 'An HTTP call hits the webhook endpoint',
    payload: ['*'],
    configFields: [
      { key: 'token', label: 'Webhook token', type: 'string', required: true, help: 'The caller posts to /tenants/<tenant>/workflow-hooks/<workflow>/<token>. 12+ characters.' },
    ],
  },
  'google-sheets.row-ready': {
    label: 'A sheet row becomes ready (watched every minute)',
    payload: ['*'],
    configFields: [
      { key: 'connectionId', label: 'Managed Google connection (real source)', type: 'string' },
      { key: 'source', label: 'Source', type: 'select', options: ['demo-sheet', 'google'], default: 'demo-sheet', required: true },
      { key: 'spreadsheetId', label: 'Spreadsheet ID (google)', type: 'string' },
      { key: 'sheetId', label: 'Sheet ID, numeric (google)', type: 'number', default: 0 },
      { key: 'watchColumn', label: 'Watch column', type: 'string', default: 'process' },
      { key: 'watchValue', label: 'Ready when the column equals', type: 'string', default: 'OK' },
      { key: 'doneColumn', label: 'Done column (skip when it equals)', type: 'string', default: 'cree' },
      { key: 'doneValue', label: 'Done value', type: 'string', default: 'ok' },
    ],
    /** The row watcher: returns the ready rows of the configured sheet. Called by the core poller. */
    async poll(config, { settings, log }) {
      const src = sheetSource(config, false);
      if (src.source === 'demo-sheet') {
        const rows = demoSheet.readyRows(config);
        log?.(`demo sheet: ${rows.length} ready row(s)`);
        return rows;
      }
      const auth = googleAuth(settings);
      if (!auth) { log?.('google source but no service account configured: watcher idle'); return []; }
      const list = await readGoogleRows(auth, src);
      const watch = config.watchColumn ?? 'process', watchValue = config.watchValue ?? 'OK';
      const done = config.doneColumn ?? 'cree', doneValue = config.doneValue ?? 'ok';
      return list
        .filter((r) => String(r.values[watch] ?? '') === watchValue && String(r.values[done] ?? '') !== doneValue);
    },
  },
};


TRIGGER_EVENTS['jira.issue-done'] = {
  label: 'A Jira ticket is in Done (watched every minute)',
  payload: ['key', 'summary', 'status', 'updated'],
  configFields: [
    { key: 'connectionId', label: 'Managed Jira connection', type: 'string', required: true },
    { key: 'project', label: 'Jira project key', type: 'string', required: true, default: 'KAN' },
    { key: 'label', label: 'Only tickets with this label', type: 'string', default: 'badge-demo' },
    { key: 'doneStatus', label: 'Status name that means done', type: 'string', default: 'Done' },
    { key: 'lookbackDays', label: 'Look back (days, 1-30)', type: 'number', default: 7 },
  ],
  /** Returns the done tickets (read-only search). The core poller starts one run per ticket key. */
  async poll(config, { settings, log }) {
    const issues = await readDoneIssues(settings, config);
    log?.(`jira: ${issues.length} ticket(s) in the done status`);
    return issues;
  },
};

export const DEMO_SHEET_INFO = { columns: DEMO_SHEET_COLUMNS };
