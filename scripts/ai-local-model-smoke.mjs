// Real local model, real agent loop: a tool-calling model served by Ollama must call a read tool (executed without
// confirmation), then ask for a write tool that the loop PAUSES (never executed), and a denial must keep it unexecuted.
// Usage: IAM_AI_LOCAL_URL=http://127.0.0.1:11434/v1 IAM_AI_LOCAL_MODEL=qwen2.5:3b node scripts/ai-local-model-smoke.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const providers = await import(join(root, 'plugins/ai-assistant/providers.mjs'));
const agent = await import(join(root, 'plugins/ai-assistant/agent.mjs'));
const model = { kind: 'openai-compatible', baseUrl: process.env.IAM_AI_LOCAL_URL ?? 'http://127.0.0.1:11434/v1', model: process.env.IAM_AI_LOCAL_MODEL ?? 'qwen2.5:3b', maxTokens: 512 };
const tools = [
  { name: 'list_users', description: 'List the directory users. Read only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'create_role', description: 'Create a role with the given name. Changes the directory.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
];
const kinds = { list_users: 'read', create_role: 'write' };
const executed = [];
const mk = () => ({ tools, kindOf: (n) => kinds[n], autoApproveWrites: false,
  callModel: (m) => providers.callModel({ model, apiKey: null, system: agent.SYSTEM_PROMPT, messages: m, tools, timeoutMs: 300_000 }),
  callTool: async (n, a) => { executed.push(n); return n === 'list_users' ? JSON.stringify([{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }]) : 'created'; } });
let ok = false; let last;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  executed.length = 0;
  const user = { role: 'user', content: 'First list the users. Then create a role named "auditors". Use the tools.' };
  const r1 = await agent.runAgent({ messages: [user], host: mk() });
  last = { attempt, status: r1.status, executed: [...executed], pending: r1.pending.map((p) => p.name), trace: r1.trace.map((t) => `${t.tool}:${t.outcome}`) };
  console.log(JSON.stringify(last));
  if (r1.status !== 'needs_confirmation' || !r1.pending.some((p) => p.name === 'create_role')) continue;
  if (executed.includes('create_role')) throw new Error('create_role ran without confirmation');
  const history = [user, ...r1.added];
  const decisions = Object.fromEntries(r1.pending.map((p) => [p.id, 'deny']));
  const r2 = await agent.runAgent({ messages: history, host: mk(), decisions });
  console.log(JSON.stringify({ afterDenial: r2.status, executed: [...executed] }));
  if (executed.includes('create_role')) throw new Error('create_role ran after the user declined');
  ok = executed.includes('list_users');
}
if (!ok) { console.error('FAIL: the real model did not complete the read-then-confirm flow', JSON.stringify(last)); process.exit(1); }
console.log('OK: real local model called a read tool, was paused on the write, and a denial left it unexecuted');
