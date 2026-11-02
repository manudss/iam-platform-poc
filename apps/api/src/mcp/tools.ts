import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { UsersService } from '../users/users.service.js';
import { AuditService } from '../access/audit.service.js';
import { McpSessionService, McpSession } from './session.service.js';
import { branchContext } from '../workspace/context.js';
import { SOD_SQL } from '../dolt/dolt.service.js';
import { checkSql, scanSql } from '../versioning/guards.js';

/**
 * MCP tool surface of the IAM POC. Design rules (enforced here, server-side - never a prompt instruction):
 *  - reads run on the session branch and never expose credentials, outbox or secret-like tables/columns;
 *  - writes run ONLY on the session branch through the same guarded services as the human console
 *    (main is read-only, SQL is filtered, SoD checks apply);
 *  - lifecycle tools can only create a FRESH branch from main, rebase the session branch on main, or open
 *    a pull request towards main. There is no tool to approve, merge, close, apply, or pick an existing branch,
 *    and no way to reach those routes with an MCP secret (they require an IdP token + admin capability).
 */
export interface ToolCtx {
  session: McpSession;
  tenant: string;
  v: VersioningService;
  prs: PullRequestService;
  users: UsersService;
  sessions: McpSessionService;
  audit: AuditService;
  core: string;
}

type Kind = 'read' | 'write' | 'lifecycle';

/** A refusal by the MCP confinement itself (not by the policy engine): traced as a DENIAL. */
export class ConfinementError extends Error {}

/** Tables/columns an AI never reads or writes through MCP: simulated mail codes (2FA), credential references, secrets. */
const SENSITIVE = /\b(outbox|credential[a-z0-9_]*|[a-z0-9_]*secret[a-z0-9_]*|[a-z0-9_]*token[a-z0-9_]*|[a-z0-9_]*password[a-z0-9_]*)\b/i;

/**
 * Read/write confinement for MCP SQL, ON TOP of the console's checkSql: the pattern is applied to the SKELETONS
 * (string literals emptied, comments stripped), so aliases, CTEs, subqueries, views created through the write path
 * (checked the same way) and quoted values cannot smuggle a sensitive name past it. information_schema is refused:
 * session rows live in the meta database and stay unreachable.
 */
export function checkMcpSql(sql: string, mode: 'read' | 'write'): { tables: string[] } {
  const meta = `${process.env.DOLT_DATABASE ?? 'iam'}_meta`;
  const skeletons = skeletonsOf(sql, mode, ['information_schema', meta]);
  for (const s of skeletons) {
    const hit = s.match(SENSITIVE);
    if (hit) throw new ConfinementError(`"${hit[1]}" is not ${mode === 'read' ? 'readable' : 'writable'} through MCP`);
  }
  return { tables: tablesOf(skeletons) };
}

/** checkSql validates; scanSql gives the skeletons (literals emptied, comments stripped) for the MCP patterns. */
function skeletonsOf(sql: string, mode: 'read' | 'write', extraBlocked: string[]): string[] {
  try { checkSql(sql, mode, extraBlocked); } catch (e) { throw new ConfinementError((e as Error).message); } // every MCP-level refusal is a denial in the trace
  return scanSql(sql).skeletons;
}

function tablesOf(skeletons: string[]): string[] {
  const out = new Set<string>();
  for (const s of skeletons) for (const m of s.matchAll(/\b(?:from|into|update|join|table)\s+`?([A-Za-z0-9_]+)`?/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

export const TOOL_KINDS: Record<string, Kind> = {
  session_status: 'lifecycle',
  list_users: 'read', list_tables: 'read', read_table: 'read', query: 'read',
  list_branches: 'read', diff_vs_main: 'read', list_pull_requests: 'read',
  execute_write: 'write', upsert_user: 'write', assign_role: 'write',
  request_new_branch: 'lifecycle', rebase_on_main: 'lifecycle', submit_pull_request: 'lifecycle',
};

type DecideOut = { allow: boolean; reasons?: string[]; errors?: string[]; version?: { seq: number; commit: string } };

/** Every tool call is authorized by the SAME policy engine as humans, in tenant mode, as the session owner. */
async function decide(ctx: ToolCtx, tool: string, kind: Kind): Promise<DecideOut> {
  const action = `Action::"mcp:${kind}"`, resource = `Branch::"${ctx.session.branch}"`;
  const principal = `User::"${ctx.session.owner}"`;
  let out: DecideOut;
  try {
    const res = await fetch(`${ctx.core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: ctx.tenant, principal, action, resource, context: {} }) });
    out = res.ok ? ((await res.json()) as DecideOut) : { allow: false, reasons: [`core-error-${res.status}`] };
  } catch { out = { allow: false, reasons: ['core-unreachable'] }; }
  await ctx.audit.record({
    tenant: ctx.tenant, subject: ctx.session.owner, principal, action, resource, allow: out.allow === true,
    reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null,
    source: 'agent', note: `mcp session=${ctx.session.id} tool=${tool}`,
  });
  return out;
}

type Run = () => Promise<{ result: unknown; detail: string; targets?: string[]; rowCount?: number | null }>;

/** decide -> act -> trace. Denials and errors are traced too: the trace is the whole point. */
async function guarded(ctx: ToolCtx, tool: string, run: Run) {
  const kind = TOOL_KINDS[tool];
  const rec = (allow: boolean, reasons: string[], detail: string, targets: string[], rowCount: number | null, error: string | null) =>
    ctx.sessions.record({ tenant: ctx.tenant, sessionId: ctx.session.id, owner: ctx.session.owner, branch: ctx.session.branch, tool, kind, detail, targets, allow, reasons, rowCount, error });
  const deny = async (reasons: string[]) => {
    await rec(false, reasons, '', [], null, 'denied');
    return { content: [{ type: 'text' as const, text: `denied: ${reasons.join('; ')}` }], isError: true };
  };
  const d = await decide(ctx, tool, kind);
  if (!d.allow) return deny(d.reasons?.length ? d.reasons : ['denied by policy']);
  if ((kind === 'write' || tool === 'submit_pull_request') && ctx.session.submitted && tool !== 'request_new_branch')
    return deny(['session already submitted its pull request; ask for request_new_branch to start a new work cycle']);
  try {
    const r = await run();
    await ctx.sessions.touch(ctx.session.id);
    await rec(true, [], r.detail, r.targets ?? [], r.rowCount ?? null, null);
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.result, null, 2) }] };
  } catch (e) {
    const msg = (e as Error).message ?? 'error';
    if (e instanceof ConfinementError) { await rec(false, [msg], '', [], null, 'denied'); return { content: [{ type: 'text' as const, text: `denied: ${msg}` }], isError: true }; }
    await rec(true, [], '', [], null, msg);
    return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true };
  }
}

const onBranch = <T>(ctx: ToolCtx, fn: () => Promise<T>) => branchContext.run({ branch: ctx.session.branch }, fn);
const text = (v: unknown) => JSON.stringify(v);

export function registerTools(server: McpServer, ctx: ToolCtx): void {
  const b = ctx.session.branch;

  server.registerTool('session_status', { description: 'Session state: working branch, expiry, pending changes vs main, whether a pull request was already submitted.' },
    () => guarded(ctx, 'session_status', async () => {
      const diff = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
      return { result: { session: ctx.session.id, branch: b, main: ctx.v.defaultBranch, expiresAt: ctx.session.expiresAt, calls: ctx.session.calls, submitted: ctx.session.submitted, pendingChanges: diff }, detail: 'session status' };
    }));

  server.registerTool('list_users', { description: 'List identities (users) of the demo directory on the working branch. Credential references are never exposed.' },
    () => guarded(ctx, 'list_users', async () => {
      const users = await onBranch(ctx, () => ctx.users.list());
      const safe = (users as Record<string, unknown>[]).map((u) => ({ id: u.id, display_name: u.display_name, manager_id: u.manager_id, department: u.department, email: u.email, login_enabled: u.login_enabled }));
      return { result: { branch: b, users: safe }, detail: 'list users', targets: ['identities'], rowCount: safe.length };
    }));

  server.registerTool('list_tables', { description: 'List the tables of the versioned database on the working branch.' },
    () => guarded(ctx, 'list_tables', async () => {
      const t = await ctx.v.tables(b);
      return { result: t, detail: 'list tables', targets: ['(schema)'] };
    }));

  server.registerTool('read_table', {
    description: 'Read rows of one table on the working branch (paginated). Sensitive tables are refused.',
    inputSchema: { table: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  },
    ({ table, limit, offset }) => guarded(ctx, 'read_table', async () => {
      const hit = table.match(SENSITIVE); if (hit) throw new ConfinementError(`"${hit[1]}" is not readable through MCP`);
      const r = await ctx.v.tableRows(b, table, limit ?? 50, offset ?? 0);
      return { result: r, detail: `read table ${table}`, targets: [table.toLowerCase()], rowCount: (r as { rows?: unknown[] }).rows?.length ?? null };
    }));

  server.registerTool('query', {
    description: 'Run ONE read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) on the working branch. Same filters as the admin console, plus MCP confinement (no outbox, credentials, secrets, information_schema).',
    inputSchema: { sql: z.string().min(1).max(20000) },
  },
    ({ sql }) => guarded(ctx, 'query', async () => {
      const { tables } = checkMcpSql(sql, 'read');
      const r = await ctx.v.sqlRead(b, sql);
      return { result: r, detail: sql.replace(/\s+/g, ' ').slice(0, 500), targets: tables, rowCount: (r as { rowCount?: number }).rowCount ?? null };
    }));

  server.registerTool('list_branches', { description: 'List the Dolt branches with their head commit (read only). The working branch cannot be changed to an existing branch.' },
    () => guarded(ctx, 'list_branches', async () => {
      const r = await ctx.v.branches();
      return { result: r, detail: 'list branches', targets: ['dolt_branches'] };
    }));

  server.registerTool('diff_vs_main', { description: 'Summarize the differences between main and the working branch (what a reviewer will look at).' },
    () => guarded(ctx, 'diff_vs_main', async () => {
      const r = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
      return { result: r, detail: 'diff vs main' };
    }));

  server.registerTool('list_pull_requests', {
    description: 'List data pull requests (read only). Approving, merging or closing a pull request is a human action and is never available here.',
    inputSchema: { status: z.enum(['open', 'merged', 'closed']).optional() },
  },
    ({ status }) => guarded(ctx, 'list_pull_requests', async () => {
      const r = await ctx.prs.list(ctx.tenant, status);
      return { result: r, detail: 'list pull requests', targets: ['pull_requests'] };
    }));

  server.registerTool('execute_write', {
    description: 'Run write SQL (INSERT/UPDATE/DELETE/REPLACE/CREATE|ALTER|DROP TABLE|INDEX|VIEW) on the working branch ONLY, committed as one Dolt commit. Same filters as the admin console. Destructive statements need confirmDestructive=true after a dry run.',
    inputSchema: { sql: z.string().min(1).max(20000), message: z.string().max(200).optional(), dryRun: z.boolean().optional(), confirmDestructive: z.boolean().optional() },
  },
    ({ sql, message, dryRun, confirmDestructive }) => guarded(ctx, 'execute_write', async () => {
      const { tables } = checkMcpSql(sql, 'write');
      const r = await onBranch(ctx, () => ctx.v.sqlWrite(b, sql, { message, dryRun, confirmDestructive }, ctx.session.owner));
      return { result: r, detail: sql.replace(/\s+/g, ' ').slice(0, 500), targets: tables, rowCount: (r as { affectedRows?: number }).affectedRows ?? null };
    }));

  server.registerTool('upsert_user', {
    description: 'Create or update a user on the working branch. Never sets a password: a created user has login_enabled=false until a human sets credentials in the console.',
    inputSchema: {
      id: z.string().regex(/^[a-z0-9-]{1,32}$/), display_name: z.string().max(80).optional(), department: z.string().max(40).optional(),
      manager_id: z.string().max(32).nullable().optional(), email: z.string().max(254).nullable().optional(), login_enabled: z.boolean().optional(),
    },
  },
    (input) => guarded(ctx, 'upsert_user', async () => {
      const { id, ...fields } = input;
      const exists = (await onBranch(ctx, () => ctx.users.list())).some((u) => u.id === id);
      const body: Record<string, unknown> = exists ? fields : { id, ...fields, login_enabled: fields.login_enabled ?? false, password: 'mcp-no-login-' + Math.random().toString(36).slice(2, 14) };
      const saved = await onBranch(ctx, () => ctx.users.save(id, body, !exists, undefined, ctx.tenant));
      const safe = saved ? { id: saved.id, display_name: saved.display_name, department: saved.department, manager_id: saved.manager_id, email: saved.email, login_enabled: saved.login_enabled } : null;
      return { result: { created: !exists, user: safe, branch: b }, detail: `${exists ? 'update' : 'create'} user ${id}`, targets: ['identities'], rowCount: 1 };
    }));

  server.registerTool('assign_role', {
    description: 'Assign a role to an identity on the working branch (with separation-of-duties check on the result).',
    inputSchema: { identity: z.string().regex(/^[a-z0-9-]{1,32}$/), role: z.string().regex(/^[a-z0-9-]{1,32}$/) },
  },
    ({ identity, role }) => guarded(ctx, 'assign_role', async () => {
      const r = await onBranch(ctx, () => ctx.v.writeOn(b, async (c) => {
        const [chk] = await c.query('select (select count(*) from identities where id=?) i,(select count(*) from roles where id=?) r', [identity, role]);
        const k = (chk as { i: number; r: number }[])[0]; if (!k.i || !k.r) throw new Error('unknown identity or role');
        await c.query('insert ignore into assignments values (?,?)', [identity, role]);
        const [dirty] = await c.query('select * from dolt_status');
        if ((dirty as unknown[]).length) { await c.query("call dolt_add('assignments')"); await c.query("call dolt_commit('-m',?)", [`mcp: assign ${role} to ${identity}`]); }
        const [violations] = await c.query(SOD_SQL);
        return { branch: b, violations, staged: true };
      }));
      return { result: r, detail: `assign ${role} to ${identity}`, targets: ['assignments'], rowCount: 1 };
    }));

  server.registerTool('request_new_branch', {
    description: 'Abandon the current line of work and start over on a FRESH branch cut from main. Choosing an existing branch as source or destination is never possible.',
    inputSchema: { reason: z.string().max(200).optional() },
  },
    ({ reason }) => guarded(ctx, 'request_new_branch', async () => {
      const s = await ctx.sessions.rotateBranch(ctx.tenant, ctx.session.id);
      ctx.session.branch = s.branch; ctx.session.seq = s.seq; ctx.session.submitted = false;
      return { result: { previousBranch: b, branch: s.branch, from: 'main', reason: reason ?? null }, detail: `new branch ${s.branch}${reason ? ` (${reason})` : ''}` };
    }));

  server.registerTool('rebase_on_main', { description: 'Merge main into the working branch so the work is up to date. Conflicts are reported, never force-resolved.' },
    () => guarded(ctx, 'rebase_on_main', async () => {
      const diff = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
      if (!diff.tables.length) return { result: { mergeable: true, upToDate: true, note: 'main has nothing the working branch lacks' }, detail: `rebase ${b} on main (up to date)` };
      const r = await ctx.v.mergeInto(ctx.v.defaultBranch, b, `mcp: rebase ${b} on main`, ctx.session.owner);
      return { result: r, detail: `rebase ${b} on main` };
    }));

  server.registerTool('submit_pull_request', {
    description: 'Finish the work cycle: open a data pull request from the working branch towards main. A HUMAN must review and merge it - this tool can never approve, merge or close it. After submitting, the session becomes read-only until request_new_branch.',
    inputSchema: { title: z.string().min(1).max(200), body: z.string().max(5000).optional() },
  },
    ({ title, body }) => guarded(ctx, 'submit_pull_request', async () => {
      const r = await ctx.prs.create(ctx.tenant, { title, body, source: b, target: ctx.v.defaultBranch }, ctx.session.owner);
      await ctx.sessions.markSubmitted(ctx.tenant, ctx.session.id);
      ctx.session.submitted = true;
      return { result: { pullRequest: r, note: 'Human review required. This session cannot approve, merge or close it.' }, detail: `submit PR ${text(title).slice(0, 200)}`, targets: ['pull_requests'] };
    }));
}
