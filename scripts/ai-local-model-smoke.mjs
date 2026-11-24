// Real local model, real AI SDK chat turn, real MCP server (the SDK one, stateless HTTP like our gateway): a tool-calling model
// served by Ollama must call the MCP tools through the SDK loop and get their results back. The tools are stand-ins (no Dolt
// and no Cedar here: the e2e job covers those).
// Usage: IAM_AI_LOCAL_URL=http://127.0.0.1:11434/v1 IAM_AI_LOCAL_MODEL=qwen2.5:3b node scripts/ai-local-model-smoke.mjs
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(root, 'apps/api/package.json'));
const { McpServer } = req('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = req('@modelcontextprotocol/sdk/server/streamableHttp.js');
const z = req('zod');
const providers = await import(join(root, 'plugins/ai-assistant/providers.mjs'));
const chat = await import(join(root, 'plugins/ai-assistant/chat.mjs'));
const executed = [];
const mcp = http.createServer(async (rq, rs) => {
  let b = ''; for await (const c of rq) b += c;
  const server = new McpServer({ name: 'smoke', version: '1' });
  server.registerTool('list_users', { description: 'List the directory users. Read only.', inputSchema: {} }, async () => { executed.push('list_users'); return { content: [{ type: 'text', text: JSON.stringify([{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }]) }] }; });
  server.registerTool('create_role', { description: 'Create a role with the given name. Changes the directory.', inputSchema: { name: z.string() } }, async () => { executed.push('create_role'); return { content: [{ type: 'text', text: 'created' }] }; });
  const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); rs.on('close', () => { tr.close(); server.close(); });
  await server.connect(tr); await tr.handleRequest(rq, rs, b ? JSON.parse(b) : undefined);
});
await new Promise((ok) => mcp.listen(0, '127.0.0.1', ok));
const model = { kind: 'openai-compatible', baseUrl: process.env.IAM_AI_LOCAL_URL ?? 'http://127.0.0.1:11434/v1', model: process.env.IAM_AI_LOCAL_MODEL ?? 'qwen2.5:3b' };
const languageModel = providers.createLanguageModel({ model, apiKey: null });
const opened = await chat.openMcp({ url: `http://127.0.0.1:${mcp.address().port}/mcp`, token: 'smoke' });
async function turn(messages) {
  const result = await chat.startTurn({ languageModel, opened, messages, maxTokens: 512, abortSignal: AbortSignal.timeout(300_000) });
  let final = []; const res = new PassThrough(); Object.assign(res, { setHeader() {}, setHeaders() {}, flushHeaders() {}, writeHead() { return res; }, statusCode: 200 }); res.resume();
  await new Promise((ok) => { res.on('end', ok); chat.pipeTurn({ result, response: res, tools: opened.tools, originalMessages: messages, onFinish: (e) => { final = e.messages; } }); });
  return final;
}
let ok = false; let last;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  executed.length = 0;
  const msgs = await turn([{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'First list the users. Then create a role named "auditors". Use the tools.' }] }]);
  const used = msgs.flatMap((m) => m.parts).filter((p) => p.type === 'dynamic-tool').map((p) => `${p.toolName}:${p.state}`);
  last = { attempt, executed: [...executed], used, answer: msgs.at(-1)?.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').slice(0, 120) };
  console.log(JSON.stringify(last));
  ok = executed.includes('list_users') && used.some((u) => u === 'list_users:output-available');
}
await opened.client.close(); mcp.close();
if (!ok) { console.error('FAIL: the real model did not call the MCP tools through the SDK loop', JSON.stringify(last)); process.exit(1); }
console.log('OK: a real local model called MCP tools through the AI SDK chat turn (tool results fed back to the model)');
process.exit(0);
