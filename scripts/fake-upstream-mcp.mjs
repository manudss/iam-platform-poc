#!/usr/bin/env node
/**
 * Fake external MCP server ("sandbox Jira") for tests and local demos of the MCP gateway (P1).
 * Zero dependencies, stateless streamable HTTP (JSON or SSE replies), Bearer-token protected.
 *
 *   node scripts/fake-upstream-mcp.mjs --port 4100 --token demo-upstream-token
 *
 * Register it in the IAM console (MCP page > External MCP servers) with URL http://127.0.0.1:4100
 * and the same token; its tools then appear in every MCP session as fake__searchIssues etc.
 */
import { createServer } from 'node:http';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : (process.env[name.toUpperCase().replace(/-/g, '_')] ?? dflt); };
const PORT = Number(arg('port', 4100));
const TOKEN = String(arg('token', 'demo-upstream-token'));

const ISSUES = {
  'FAKE-101': { key: 'FAKE-101', summary: 'Migrate off the legacy IdP', status: 'In Progress', assignee: 'a.martin', priority: 'High' },
  'FAKE-102': { key: 'FAKE-102', summary: 'Audit trail gaps on role changes', status: 'To Do', assignee: null, priority: 'Medium' },
  'FAKE-103': { key: 'FAKE-103', summary: 'Pilot customer onboarding checklist', status: 'Done', assignee: 's.dupont', priority: 'Low' },
};
let created = 200;

const TOOLS = [
  { name: 'searchIssues', description: 'Search sandbox Jira issues by text (demo data).', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'text to find in summaries' }, maxResults: { type: 'integer', description: 'max issues to return (default 10)' } }, required: ['query'] } },
  { name: 'getIssue', description: 'Get one sandbox Jira issue by key.', inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'issue key, e.g. FAKE-101' } }, required: ['key'] } },
  { name: 'createIssue', description: 'Create a sandbox Jira issue (a WRITE: nothing here is real).', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'issue summary' }, description: { type: 'string', description: 'issue body' } }, required: ['summary'] } },
];

const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
function call(name, args = {}) {
  if (name === 'searchIssues') {
    const q = String(args.query ?? '').toLowerCase();
    const hits = Object.values(ISSUES).filter((i) => i.summary.toLowerCase().includes(q)).slice(0, Number(args.maxResults) || 10);
    return text({ issues: hits, total: hits.length });
  }
  if (name === 'getIssue') {
    const issue = ISSUES[String(args.key ?? '').toUpperCase()];
    if (!issue) { const e = new Error(`unknown issue key: ${args.key}`); e.rpc = -32602; throw e; }
    return text(issue);
  }
  if (name === 'createIssue') {
    if (!args.summary || typeof args.summary !== 'string') { const e = new Error('summary is required'); e.rpc = -32602; throw e; }
    const key = `FAKE-${++created}`;
    ISSUES[key] = { key, summary: args.summary, status: 'To Do', assignee: null, priority: 'Medium' };
    return text({ created: true, issue: ISSUES[key] });
  }
  const e = new Error(`unknown tool: ${name}`); e.rpc = -32602; throw e;
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const reply = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'missing or bad bearer token' } });
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const { id, method, params } = msg;
    try {
      let result;
      if (method === 'initialize') result = { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake-jira-sandbox', version: '0.1.0' } };
      else if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      else if (method === 'tools/list') result = { tools: TOOLS };
      else if (method === 'tools/call') result = call(params?.name, params?.arguments);
      else { const e = new Error(`unknown method: ${method}`); e.rpc = -32601; throw e; }
      reply(200, { jsonrpc: '2.0', id, result });
    } catch (e) { reply(200, { jsonrpc: '2.0', id, error: { code: e.rpc ?? -32000, message: e.message } }); }
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake-upstream-mcp (sandbox Jira) on http://127.0.0.1:${PORT} (Bearer ${TOKEN.length}-char token)`));
