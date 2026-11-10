import { createRequire } from 'node:module';
import { runPieceAction } from './adapter.mjs';
import { demoSheet, DEMO_SHEET_COLUMNS } from './demo-sheet.mjs';

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
  return { props: { serviceAccount, userEmail: str(settings?.googleUserEmail, 'google user', 200, false) || undefined } };
};

// ---------------------------------------------------------------- HTTP request (Activepieces piece-http) ----
const httpRequest = {
  type: 'http-request',
  family: 'Connectors',
  label: 'HTTP request (Activepieces)',
  simulated: false,
  description: 'Real HTTP call through the Activepieces http piece. Every destination host must be explicitly allow-listed. Redirects are not followed. {{event.x}} / {{steps.x.y}} placeholders OK in url, headers, body.',
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
    if (out.headers && !out.headers.includes('{{')) { try { JSON.parse(out.headers); } catch { bad('http-request.headers: a JSON object (or placeholders)'); } }
    if (!out.url.includes('{{')) guardUrl(out.url, {}, false);
    return out;
  },
  async run(ctx) {
    const c = ctx.config;
    const url = guardUrl(c.url, ctx.settings);
    let headers = {};
    if (c.headers) { try { headers = JSON.parse(c.headers); } catch { bad('http-request.headers: not a JSON object after substitution'); } }
    if (ctx.dryRun) {
      ctx.log(`DRY-RUN: would send ${c.method} ${url}${c.body ? ` with ${c.body.length} chars of body` : ''} (nothing sent)`);
      return { status: 0, body: null, ok: true, dryRun: true };
    }
    const result = await runPieceAction('@activepieces/piece-http', 'send_request', {
      auth: undefined,
      propsValue: {
        method: c.method, url, headers, queryParams: {},
        authType: 'none', body_type: 'raw', body: c.body || '',
        response_is_binary: false, use_proxy: false,
        timeout: c.timeout, followRedirects: false, failureMode: 'retry_none',
      },
    });
    const body = typeof result?.body === 'string' ? result.body.slice(0, 2000) : result?.body ?? null;
    ctx.log(`HTTP ${result?.status} from ${url} (real call, Activepieces http piece)`);
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
  { key: 'source', label: 'Source', type: 'select', options: ['demo-sheet', 'google'], default: 'demo-sheet', required: true, help: 'demo-sheet = the built-in SIMULATED sheet; google = the real API (needs the service account in the plugin settings)' },
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
    if (c.source === 'demo-sheet') {
      let found = demoSheet.rows();
      if (c.mode === 'find-row') found = found.filter((r) => String(r.values[c.columnName] ?? '') === String(c.searchValue));
      const first = found[0];
      ctx.log(`read ${found.length} row(s) from the DEMO sheet (simulated source, no Google call)`);
      return { rows: found.map((r) => r.values), row: first?.values ?? null, rowNumber: first?.rowNumber ?? 0, count: found.length };
    }
    const auth = googleAuth(ctx.settings);
    if (!auth) bad('google-sheets-read: type the Google service account JSON key in the workflow-connectors plugin settings first (console)');
    if (c.mode === 'find-row') {
      const rows = await runPieceAction('@activepieces/piece-google-sheets', 'find_rows', {
        auth, propsValue: { spreadsheetId: c.spreadsheetId, sheetId: c.sheetId, columnName: c.columnName, searchValue: c.searchValue, matchCase: false, headerRow: 1, useHeaderNames: true, includeTeamDrives: false },
      });
      const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
      ctx.log(`Google Sheets find_rows: ${list.length} match(es) (real API call)`);
      return { rows: list, row: list[0] ?? null, rowNumber: 0, count: list.length };
    }
    const values = await runPieceAction('@activepieces/piece-google-sheets', 'get-many-rows', {
      auth, propsValue: { spreadsheetId: c.spreadsheetId, sheetId: c.sheetId, includeTeamDrives: false, first_row_headers: true },
    });
    const list = Array.isArray(values) ? values : values ? [values] : [];
    ctx.log(`Google Sheets get-many-rows: ${list.length} row(s) (real API call)`);
    return { rows: list, row: list[0] ?? null, rowNumber: 0, count: list.length };
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
    const rowNumber = Number(c.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) bad(`google-sheets-update.rowNumber: an integer >= 2 (got "${c.rowNumber}")`);
    if (c.source === 'demo-sheet') {
      demoSheet.updateCell(rowNumber, c.column, c.value);
      ctx.log(`DEMO sheet: row ${rowNumber}, column "${c.column}" <- "${c.value}" (simulated sheet, no Google call)`);
      return { updated: true };
    }
    const auth = googleAuth(ctx.settings);
    if (!auth) bad('google-sheets-update: type the Google service account JSON key in the workflow-connectors plugin settings first (console)');
    await runPieceAction('@activepieces/piece-google-sheets', 'update_row', {
      auth, propsValue: { spreadsheetId: c.spreadsheetId, sheetId: c.sheetId, row_id: rowNumber, first_row_headers: true, includeTeamDrives: false, values: { [c.column]: c.value } },
    });
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
    if (!auth) bad('google-sheets-add-row: type the Google service account JSON key in the workflow-connectors plugin settings first (console)');
    const result = await runPieceAction('@activepieces/piece-google-sheets', 'insert_row', {
      auth, propsValue: { spreadsheetId: c.spreadsheetId, sheetId: c.sheetId, first_row_headers: true, includeTeamDrives: false, as_string: false, values },
    });
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
    return { key, url: key ? `${instanceUrl.replace(/\/$/, '')}/browse/${key}` : null };
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

export const BLOCKS = [httpRequest, textTransform, sheetsRead, sheetsUpdate, sheetsAddRow, jiraCreateIssue, jiraSearchIssues, lyamCreateUser];

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
      const values = await runPieceAction('@activepieces/piece-google-sheets', 'get-many-rows', {
        auth, propsValue: { spreadsheetId: src.spreadsheetId, sheetId: src.sheetId, includeTeamDrives: false, first_row_headers: true },
      });
      const list = Array.isArray(values) ? values : values ? [values] : [];
      const watch = config.watchColumn ?? 'process', watchValue = config.watchValue ?? 'OK';
      const done = config.doneColumn ?? 'cree', doneValue = config.doneValue ?? 'ok';
      return list
        .map((v, i) => ({ rowNumber: i + 2, values: v }))
        .filter((r) => String(r.values[watch] ?? '') === watchValue && String(r.values[done] ?? '') !== doneValue);
    },
  },
};

export const DEMO_SHEET_INFO = { columns: DEMO_SHEET_COLUMNS };
