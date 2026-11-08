/**
 * mcp-gateway plugin: the MCP tool surface of the IAM POC and its confinement. Design rules (enforced
 * here, server-side - never a prompt instruction):
 *  - reads run on the session branch and never expose credentials, outbox or secret-like tables/columns;
 *  - writes run ONLY on the session branch through the same guarded services as the human console
 *    (main is read-only, SQL is filtered, SoD checks apply);
 *  - lifecycle tools can only create a FRESH branch from main, rebase the session branch on main, or open
 *    a pull request towards main. There is no tool to approve, merge, close, apply, or pick an existing branch,
 *    and no way to reach those routes with an MCP secret (they require an IdP token + admin capability).
 *
 * The core adapter (apps/api/src/mcp/tools.ts) binds the core security primitives at startup
 * (bindCoreApi: SQL guards, event scrubber, SoD SQL, branch context) and injects the per-call services
 * through the ToolCtx object, exactly as before.
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { z } = require('zod');

let coreApi;
/** Called once by the core adapter: { checkSql, scanSql, scrub, SOD_SQL, branchRun }. */
export function bindCoreApi(api) { coreApi = api; }
/** A refusal by the MCP confinement itself (not by the policy engine): traced as a DENIAL. */
export class ConfinementError extends Error {
}
/** Tables/columns an AI never reads or writes through MCP: simulated mail codes (2FA), credential references, secrets. */
const SENSITIVE = /\b(outbox|credential[a-z0-9_]*|[a-z0-9_]*secret[a-z0-9_]*|[a-z0-9_]*token[a-z0-9_]*|[a-z0-9_]*password[a-z0-9_]*)\b/i;
/**
 * Read/write confinement for MCP SQL, ON TOP of the console's checkSql: the pattern is applied to the SKELETONS
 * (string literals emptied, comments stripped), so aliases, CTEs, subqueries, views created through the write path
 * (checked the same way) and quoted values cannot smuggle a sensitive name past it. information_schema is refused:
 * session rows live in the meta database and stay unreachable.
 */
export function checkMcpSql(sql, mode) {
    const meta = `${process.env.DOLT_DATABASE ?? 'iam'}_meta`;
    const skeletons = skeletonsOf(sql, mode, ['information_schema', meta]);
    for (const s of skeletons) {
        const hit = s.match(SENSITIVE);
        if (hit)
            throw new ConfinementError(`"${hit[1]}" is not ${mode === 'read' ? 'readable' : 'writable'} through MCP`);
    }
    return { tables: tablesOf(skeletons) };
}
/** checkSql validates; scanSql gives the skeletons (literals emptied, comments stripped) for the MCP patterns. */
function skeletonsOf(sql, mode, extraBlocked) {
    try {
        coreApi.checkSql(sql, mode, extraBlocked);
    }
    catch (e) {
        throw new ConfinementError(e.message);
    } // every MCP-level refusal is a denial in the trace
    return coreApi.scanSql(sql).skeletons;
}
function tablesOf(skeletons) {
    const out = new Set();
    for (const s of skeletons)
        for (const m of s.matchAll(/\b(?:from|into|update|join|table)\s+`?([A-Za-z0-9_]+)`?/gi))
            out.add(m[1].toLowerCase());
    return [...out];
}
export const TOOL_KINDS = {
    session_status: 'lifecycle',
    list_users: 'read', list_tables: 'read', read_table: 'read', query: 'read',
    list_branches: 'read', diff_vs_main: 'read', list_pull_requests: 'read',
    execute_write: 'write', upsert_user: 'write', assign_role: 'write',
    unassign_role: 'write', save_role: 'write', delete_role: 'write', add_sod_rule: 'write', remove_sod_rule: 'write',
    save_profile_config: 'write',
    create_organization: 'write', update_organization: 'write', delete_organization: 'write', assign_organizations: 'write',
    install_plugin: 'write', configure_plugin: 'write', set_plugin_enabled: 'write',
    list_roles: 'read', list_organizations: 'read', list_plugins: 'read',
    list_event_records: 'read', list_workflows: 'read', get_workflow: 'read', list_workflow_runs: 'read',
    save_workflow: 'write', delete_workflow: 'write', test_workflow: 'read', get_authn_config: 'read', save_authn_config: 'write',
    request_new_branch: 'lifecycle', rebase_on_main: 'lifecycle', submit_pull_request: 'lifecycle',
};
/** Every tool call is authorized by the SAME policy engine as humans, in tenant mode, as the session owner. */
async function decide(ctx, tool, kind, resourceOverride) {
    const action = `Action::"mcp:${kind}"`, resource = resourceOverride ?? `Branch::"${ctx.session.branch}"`;
    const principal = `User::"${ctx.session.owner}"`;
    let out;
    let answered = false;
    try {
        const res = await fetch(`${ctx.core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: ctx.tenant, principal, action, resource, context: {}, audit: { source: 'agent', subject: ctx.session.owner, note: `mcp session=${ctx.session.id} tool=${tool}` } }) });
        answered = res.ok;
        out = res.ok ? (await res.json()) : { allow: false, reasons: [`core-error-${res.status}`] };
    }
    catch {
        out = { allow: false, reasons: ['core-unreachable'] };
    }
    await ctx.audit.recordDecision({
        tenant: ctx.tenant, subject: ctx.session.owner, principal, action, resource, allow: out.allow === true,
        reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null,
        source: 'agent', note: `mcp session=${ctx.session.id} tool=${tool}`,
    }, answered);
    return out;
}
/** decide -> act -> trace. Denials and errors are traced too: the trace is the whole point. */
async function guarded(ctx, tool, run) {
    return guardedWithKind(ctx, tool, TOOL_KINDS[tool], run);
}
/** Same as guarded with an explicit kind: relayed (proxy) tools are registered dynamically, outside TOOL_KINDS. */
export async function guardedWithKind(ctx, tool, kind, run, resourceOverride) {
    const rec = (allow, reasons, detail, targets, rowCount, error) => ctx.sessions.record({ tenant: ctx.tenant, sessionId: ctx.session.id, owner: ctx.session.owner, branch: ctx.session.branch, tool, kind, detail, targets, allow, reasons, rowCount, error });
    const deny = async (reasons) => {
        await rec(false, reasons, '', [], null, 'denied');
        return { content: [{ type: 'text', text: `denied: ${reasons.join('; ')}` }], isError: true };
    };
    const d = await decide(ctx, tool, kind, resourceOverride);
    if (!d.allow)
        return deny(d.reasons?.length ? d.reasons : ['denied by policy']);
    if ((kind === 'write' || tool === 'submit_pull_request') && ctx.session.submitted && tool !== 'request_new_branch')
        return deny(['session already submitted its pull request; ask for request_new_branch to start a new work cycle']);
    try {
        const r = await run();
        await ctx.sessions.touch(ctx.session.id);
        await rec(true, [], r.detail, r.targets ?? [], r.rowCount ?? null, null);
        return { content: [{ type: 'text', text: JSON.stringify(r.result, null, 2) }] };
    }
    catch (e) {
        const msg = e.message ?? 'error';
        if (e instanceof ConfinementError) {
            await rec(false, [msg], '', [], null, 'denied');
            return { content: [{ type: 'text', text: `denied: ${msg}` }], isError: true };
        }
        await rec(true, [], '', [], null, msg);
        return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true };
    }
}
const onBranch = (ctx, fn) => coreApi.branchRun(ctx.session.branch, fn);
/** Same feature gate as the human console: workflow tools only exist for the AI when the plugin is enabled on the working branch. */
const needWorkflows = async (ctx) => {
    const reg = await ctx.branches.get(ctx.session.branch);
    if (!(await reg.isActive(ctx.tenant, 'workflows-iga')))
        throw new Error('the workflows-iga plugin is not enabled on the working branch');
};
const text = (v) => JSON.stringify(v);
export function registerTools(server, ctx) {
    const b = ctx.session.branch;
    server.registerTool('session_status', { description: 'Session state: working branch, expiry, pending changes vs main, whether a pull request was already submitted.' }, () => guarded(ctx, 'session_status', async () => {
        const diff = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
        return { result: { session: ctx.session.id, branch: b, main: ctx.v.defaultBranch, expiresAt: ctx.session.expiresAt, calls: ctx.session.calls, submitted: ctx.session.submitted, pendingChanges: diff }, detail: 'session status' };
    }));
    server.registerTool('list_users', { description: 'List identities (users) of the demo directory on the working branch. Credential references are never exposed.' }, () => guarded(ctx, 'list_users', async () => {
        const users = await onBranch(ctx, () => ctx.users.list());
        const safe = users.map((u) => ({ id: u.id, display_name: u.display_name, manager_id: u.manager_id, department: u.department, email: u.email, login_enabled: u.login_enabled }));
        return { result: { branch: b, users: safe }, detail: 'list users', targets: ['identities'], rowCount: safe.length };
    }));
    server.registerTool('list_tables', { description: 'List the tables of the versioned database on the working branch.' }, () => guarded(ctx, 'list_tables', async () => {
        const t = await ctx.v.tables(b);
        return { result: t, detail: 'list tables', targets: ['(schema)'] };
    }));
    server.registerTool('read_table', {
        description: 'Read rows of one table on the working branch (paginated). Sensitive tables are refused.',
        inputSchema: { table: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
    }, ({ table, limit, offset }) => guarded(ctx, 'read_table', async () => {
        const hit = table.match(SENSITIVE);
        if (hit)
            throw new ConfinementError(`"${hit[1]}" is not readable through MCP`);
        const r = await ctx.v.tableRows(b, table, limit ?? 50, offset ?? 0);
        return { result: r, detail: `read table ${table}`, targets: [table.toLowerCase()], rowCount: r.rows?.length ?? null };
    }));
    server.registerTool('query', {
        description: 'Run ONE read-only SQL statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH) on the working branch. Same filters as the admin console, plus MCP confinement (no outbox, credentials, secrets, information_schema).',
        inputSchema: { sql: z.string().min(1).max(20000) },
    }, ({ sql }) => guarded(ctx, 'query', async () => {
        const { tables } = checkMcpSql(sql, 'read');
        const r = await ctx.v.sqlRead(b, sql);
        return { result: r, detail: sql.replace(/\s+/g, ' ').slice(0, 500), targets: tables, rowCount: r.rowCount ?? null };
    }));
    server.registerTool('list_branches', { description: 'List the Dolt branches with their head commit (read only). The working branch cannot be changed to an existing branch.' }, () => guarded(ctx, 'list_branches', async () => {
        const r = await ctx.v.branches();
        return { result: r, detail: 'list branches', targets: ['dolt_branches'] };
    }));
    server.registerTool('diff_vs_main', { description: 'Summarize the differences between main and the working branch (what a reviewer will look at).' }, () => guarded(ctx, 'diff_vs_main', async () => {
        const r = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
        return { result: r, detail: 'diff vs main' };
    }));
    server.registerTool('list_pull_requests', {
        description: 'List data pull requests (read only). Approving, merging or closing a pull request is a human action and is never available here.',
        inputSchema: { status: z.enum(['open', 'merged', 'closed']).optional() },
    }, ({ status }) => guarded(ctx, 'list_pull_requests', async () => {
        const r = await ctx.prs.list(ctx.tenant, status);
        return { result: r, detail: 'list pull requests', targets: ['pull_requests'] };
    }));
    server.registerTool('execute_write', {
        description: 'Run write SQL (INSERT/UPDATE/DELETE/REPLACE/CREATE|ALTER|DROP TABLE|INDEX|VIEW) on the working branch ONLY, committed as one Dolt commit. Same filters as the admin console. Destructive statements need confirmDestructive=true after a dry run.',
        inputSchema: { sql: z.string().min(1).max(20000), message: z.string().max(200).optional(), dryRun: z.boolean().optional(), confirmDestructive: z.boolean().optional() },
    }, ({ sql, message, dryRun, confirmDestructive }) => guarded(ctx, 'execute_write', async () => {
        const { tables } = checkMcpSql(sql, 'write');
        const r = await onBranch(ctx, () => ctx.v.sqlWrite(b, sql, { message, dryRun, confirmDestructive }, ctx.session.owner));
        return { result: r, detail: sql.replace(/\s+/g, ' ').slice(0, 500), targets: tables, rowCount: r.affectedRows ?? null };
    }));
    server.registerTool('upsert_user', {
        description: 'Create or update a user on the working branch. Never sets a password: a created user has login_enabled=false until a human sets credentials in the console.',
        inputSchema: {
            id: z.string().regex(/^[a-z0-9-]{1,32}$/), display_name: z.string().max(80).optional(), department: z.string().max(40).optional(),
            manager_id: z.string().max(32).nullable().optional(), email: z.string().max(254).nullable().optional(), login_enabled: z.boolean().optional(),
        },
    }, (input) => guarded(ctx, 'upsert_user', async () => {
        const { id, ...fields } = input;
        const exists = (await onBranch(ctx, () => ctx.users.list())).some((u) => u.id === id);
        const body = exists ? fields : { id, ...fields, login_enabled: fields.login_enabled ?? false, password: 'mcp-no-login-' + Math.random().toString(36).slice(2, 14) };
        const saved = await onBranch(ctx, () => ctx.users.save(id, body, !exists, undefined, ctx.tenant));
        const safe = saved ? { id: saved.id, display_name: saved.display_name, department: saved.department, manager_id: saved.manager_id, email: saved.email, login_enabled: saved.login_enabled } : null;
        return { result: { created: !exists, user: safe, branch: b }, detail: `${exists ? 'update' : 'create'} user ${id}`, targets: ['identities'], rowCount: 1 };
    }));
    server.registerTool('assign_role', {
        description: 'Assign a role to an identity on the working branch (with separation-of-duties check on the result).',
        inputSchema: { identity: z.string().regex(/^[a-z0-9-]{1,32}$/), role: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ identity, role }) => guarded(ctx, 'assign_role', async () => {
        const r = await onBranch(ctx, () => ctx.v.writeOn(b, async (c) => {
            const [chk] = await c.query('select (select count(*) from identities where id=?) i,(select count(*) from roles where id=?) r', [identity, role]);
            const k = chk[0];
            if (!k.i || !k.r)
                throw new Error('unknown identity or role');
            await c.query('insert ignore into assignments values (?,?)', [identity, role]);
            const [dirty] = await c.query('select * from dolt_status');
            if (dirty.length) {
                await c.query("call dolt_add('assignments')");
                await c.query("call dolt_commit('-m',?)", [`mcp: assign ${role} to ${identity}`]);
            }
            const [violations] = await c.query(coreApi.SOD_SQL);
            return { branch: b, violations, staged: true };
        }));
        return { result: r, detail: `assign ${role} to ${identity}`, targets: ['assignments'], rowCount: 1 };
    }));
    server.registerTool('request_new_branch', {
        description: 'Abandon the current line of work and start over on a FRESH branch cut from main. Choosing an existing branch as source or destination is never possible.',
        inputSchema: { reason: z.string().max(200).optional() },
    }, ({ reason }) => guarded(ctx, 'request_new_branch', async () => {
        const s = await ctx.sessions.rotateBranch(ctx.tenant, ctx.session.id);
        ctx.session.branch = s.branch;
        ctx.session.seq = s.seq;
        ctx.session.submitted = false;
        return { result: { previousBranch: b, branch: s.branch, from: 'main', reason: reason ?? null }, detail: `new branch ${s.branch}${reason ? ` (${reason})` : ''}` };
    }));
    server.registerTool('rebase_on_main', { description: 'Merge main into the working branch so the work is up to date. Conflicts are reported, never force-resolved.' }, () => guarded(ctx, 'rebase_on_main', async () => {
        const diff = await ctx.v.diffSummary(ctx.v.defaultBranch, b, true);
        if (!diff.tables.length)
            return { result: { mergeable: true, upToDate: true, note: 'main has nothing the working branch lacks' }, detail: `rebase ${b} on main (up to date)` };
        const r = await ctx.v.mergeInto(ctx.v.defaultBranch, b, `mcp: rebase ${b} on main`, ctx.session.owner);
        return { result: r, detail: `rebase ${b} on main` };
    }));
    server.registerTool('submit_pull_request', {
        description: 'Finish the work cycle: open a data pull request from the working branch towards main. A HUMAN must review and merge it - this tool can never approve, merge or close it. After submitting, the session becomes read-only until request_new_branch.',
        inputSchema: { title: z.string().min(1).max(200), body: z.string().max(5000).optional() },
    }, ({ title, body }) => guarded(ctx, 'submit_pull_request', async () => {
        const r = await ctx.prs.create(ctx.tenant, { title, body, source: b, target: ctx.v.defaultBranch }, ctx.session.owner);
        await ctx.sessions.markSubmitted(ctx.tenant, ctx.session.id);
        ctx.session.submitted = true;
        return { result: { pullRequest: r, note: 'Human review required. This session cannot approve, merge or close it.' }, detail: `submit PR ${text(title).slice(0, 200)}`, targets: ['pull_requests'] };
    }));
    server.registerTool('unassign_role', {
        description: 'Remove a role from an identity on the working branch.',
        inputSchema: { identity: z.string().regex(/^[a-z0-9-]{1,32}$/), role: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ identity, role }) => guarded(ctx, 'unassign_role', async () => {
        const r = await onBranch(ctx, () => ctx.v.writeOn(b, async (c) => {
            await c.query('delete from assignments where identity_id=? and role_id=?', [identity, role]);
            const [dirty] = await c.query('select * from dolt_status');
            if (dirty.length) {
                await c.query("call dolt_add('assignments')");
                await c.query("call dolt_commit('-m',?)", [`mcp: unassign ${role} from ${identity}`]);
            }
            return { branch: b };
        }));
        return { result: r, detail: `unassign ${role} from ${identity}`, targets: ['assignments'], rowCount: 1 };
    }));
    server.registerTool('save_role', {
        description: 'Create or update a role (label, sensitivity) on the working branch. A role id never changes: policies refer to it.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/), label: z.string().min(1).max(80), is_sensitive: z.boolean().optional() },
    }, ({ id, label, is_sensitive }) => guarded(ctx, 'save_role', async () => {
        const exists = await onBranch(ctx, async () => (await ctx.roles.list()).roles.some((r) => r.id === id));
        const r = await onBranch(ctx, () => exists
            ? ctx.roles.update(ctx.session.owner, id, { label, is_sensitive })
            : ctx.roles.create(ctx.session.owner, { id, label, is_sensitive }));
        return { result: { created: !exists, ...r }, detail: `${exists ? 'update' : 'create'} role ${id}`, targets: ['roles'], rowCount: 1 };
    }));
    server.registerTool('delete_role', {
        description: 'Delete a role on the working branch. Refused while the role is still assigned or named in a separation-of-duties rule.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ id }) => guarded(ctx, 'delete_role', async () => {
        const r = await onBranch(ctx, () => ctx.roles.remove(ctx.session.owner, id));
        return { result: r, detail: `delete role ${id}`, targets: ['roles'], rowCount: 1 };
    }));
    server.registerTool('add_sod_rule', {
        description: 'Add a separation-of-duties rule between two roles on the working branch.',
        inputSchema: { role_a: z.string().regex(/^[a-z0-9-]{1,32}$/), role_b: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ role_a, role_b }) => guarded(ctx, 'add_sod_rule', async () => {
        const r = await onBranch(ctx, () => ctx.roles.addRule(ctx.session.owner, { role_a, role_b }));
        return { result: r, detail: `add SoD rule ${role_a} x ${role_b}`, targets: ['sod_rules'], rowCount: 1 };
    }));
    server.registerTool('remove_sod_rule', {
        description: 'Remove a separation-of-duties rule on the working branch. This loosens a control, so confirm=true is required.',
        inputSchema: { role_a: z.string().regex(/^[a-z0-9-]{1,32}$/), role_b: z.string().regex(/^[a-z0-9-]{1,32}$/), confirm: z.literal(true) },
    }, ({ role_a, role_b }) => guarded(ctx, 'remove_sod_rule', async () => {
        const r = await onBranch(ctx, () => ctx.roles.removeRule(ctx.session.owner, role_a, role_b, true));
        return { result: r, detail: `remove SoD rule ${role_a} x ${role_b}`, targets: ['sod_rules'], rowCount: 1 };
    }));
    server.registerTool('save_profile_config', {
        description: 'Replace the profile configuration on the working branch (which fields are shown, required, editable by the person, self-edit review policy). Validated against the field catalogue.',
        inputSchema: { config: z.record(z.string(), z.unknown()) },
    }, ({ config }) => guarded(ctx, 'save_profile_config', async () => {
        const saved = await onBranch(ctx, () => ctx.profile.saveConfig(ctx.tenant, config));
        return { result: saved, detail: 'save profile configuration', targets: ['plugin_config'], rowCount: 1 };
    }));
    server.registerTool('create_organization', {
        description: 'Create an organization on the working branch (requires the organizations plugin enabled on the branch).',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/), name: z.string().min(1).max(80), parent_id: z.string().regex(/^[a-z0-9-]{1,32}$/).nullable().optional() },
    }, (input) => guarded(ctx, 'create_organization', async () => {
        const r = await onBranch(ctx, () => ctx.orgs.create(ctx.tenant, ctx.session.owner, input));
        return { result: r, detail: `create organization ${input.id}`, targets: ['orgs'], rowCount: 1 };
    }));
    server.registerTool('update_organization', {
        description: 'Rename or re-parent an organization on the working branch. Cycles are refused.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/), name: z.string().min(1).max(80).optional(), parent_id: z.string().regex(/^[a-z0-9-]{1,32}$/).nullable().optional() },
    }, ({ id, ...fields }) => guarded(ctx, 'update_organization', async () => {
        const r = await onBranch(ctx, () => ctx.orgs.update(ctx.tenant, ctx.session.owner, id, fields));
        return { result: r, detail: `update organization ${id}`, targets: ['orgs'], rowCount: 1 };
    }));
    server.registerTool('delete_organization', {
        description: 'Delete an organization on the working branch. Refused while it has children or members.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ id }) => guarded(ctx, 'delete_organization', async () => {
        const r = await onBranch(ctx, () => ctx.orgs.remove(ctx.tenant, ctx.session.owner, id));
        return { result: r, detail: `delete organization ${id}`, targets: ['orgs'], rowCount: 1 };
    }));
    server.registerTool('assign_organizations', {
        description: 'Set the organizations of an identity on the working branch (replaces the current list).',
        inputSchema: { subject: z.string().regex(/^[a-z0-9-]{1,32}$/), org_ids: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(20) },
    }, ({ subject, org_ids }) => guarded(ctx, 'assign_organizations', async () => {
        const r = await onBranch(ctx, () => ctx.orgs.assign(ctx.tenant, ctx.session.owner, subject, org_ids));
        return { result: r, detail: `assign organizations ${org_ids.join(',') || '(none)'} to ${subject}`, targets: ['org_members'], rowCount: org_ids.length };
    }));
    server.registerTool('install_plugin', {
        description: 'Install a builtin plugin on the working branch: its migrations and seed run there only. The install grant is assumed requested by the caller; sensitive grants (ui components, event hooks) stay console-only.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/) },
    }, ({ id }) => guarded(ctx, 'install_plugin', async () => {
        const reg = await ctx.branches.get(b);
        await reg.install(ctx.tenant, id, { install: true, uiComponents: false, hooks: [] });
        const list = await reg.list(ctx.tenant);
        return { result: { installed: id, plugins: list }, detail: `install plugin ${id}`, targets: ['plugin_config'], rowCount: 1 };
    }));
    server.registerTool('configure_plugin', {
        description: 'Save the settings of an installed plugin on the working branch (validated against its manifest).',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/), settings: z.record(z.string(), z.unknown()) },
    }, ({ id, settings }) => guarded(ctx, 'configure_plugin', async () => {
        const reg = await ctx.branches.get(b);
        await reg.configure(ctx.tenant, id, settings);
        return { result: { configured: id }, detail: `configure plugin ${id}`, targets: ['plugin_config'], rowCount: 1 };
    }));
    server.registerTool('set_plugin_enabled', {
        description: 'Enable or disable a plugin on the working branch. Sensitive grants (ui components, event hooks) are never granted here: they remain a human console action.',
        inputSchema: { id: z.string().regex(/^[a-z0-9-]{1,32}$/), enabled: z.boolean() },
    }, ({ id, enabled }) => guarded(ctx, 'set_plugin_enabled', async () => {
        const reg = await ctx.branches.get(b);
        if (enabled)
            await reg.enable(ctx.tenant, id, { install: false, uiComponents: false, hooks: [] });
        else
            await reg.disable(ctx.tenant, id);
        return { result: { plugin: id, enabled }, detail: `${enabled ? 'enable' : 'disable'} plugin ${id}`, targets: ['plugin_config'], rowCount: 1 };
    }));
    server.registerTool('list_roles', { description: 'List roles and separation-of-duties rules on the working branch, with assignment counts.' }, () => guarded(ctx, 'list_roles', async () => {
        const r = await onBranch(ctx, () => ctx.roles.list());
        return { result: r, detail: 'list roles', targets: ['roles', 'sod_rules'], rowCount: r.roles.length };
    }));
    server.registerTool('list_organizations', { description: 'List organizations and their members on the working branch (requires the organizations plugin enabled on the branch).' }, () => guarded(ctx, 'list_organizations', async () => {
        const r = await onBranch(ctx, () => ctx.orgs.list(ctx.tenant));
        return { result: r, detail: 'list organizations', targets: ['orgs'], rowCount: r.orgs.length };
    }));
    server.registerTool('list_plugins', { description: 'List plugins with their state (installed, enabled, settings) as configured on the working branch.' }, () => guarded(ctx, 'list_plugins', async () => {
        const reg = await ctx.branches.get(b);
        const list = await reg.list(ctx.tenant);
        return { result: { plugins: list }, detail: 'list plugins', targets: ['plugin_config'], rowCount: list.length };
    }));
    server.registerTool('list_event_records', {
        description: 'Read the recent event-bus records kept by the core (observability only). Secret-like fields are scrubbed. The bus has no write route anywhere, including here.',
        inputSchema: { after: z.number().int().min(0).max(999999999).optional(), limit: z.number().int().min(1).max(500).optional() },
    }, ({ after, limit }) => guarded(ctx, 'list_event_records', async () => {
        const tok = process.env.IAM_CORE_ADMIN_TOKEN;
        if (!tok)
            throw new Error('the core admin read is not configured (IAM_CORE_ADMIN_TOKEN)');
        const res = await fetch(`${ctx.core}/v1/bus/records?after=${after ?? 0}&limit=${limit ?? 200}`, { headers: { 'x-core-admin-token': tok }, signal: AbortSignal.timeout(3000) });
        if (!res.ok)
            throw new Error(`the core refused the read (${res.status})`);
        const body = (await res.json());
        const records = (body.records ?? []).map(coreApi.scrub);
        return { result: { enabled: !!body.enabled, records, first_seq: body.first_seq ?? 0, last_seq: body.last_seq ?? 0, capacity: body.capacity ?? 0, note: body.note ?? '' }, detail: 'read event bus records', targets: ['event_bus'], rowCount: records.length };
    }));
    server.registerTool('list_workflows', { description: 'List workflow definitions (name, trigger, steps). Workflow definitions are shared live configuration: reading is allowed, but creating, editing, deleting or publishing one is never available through MCP.' }, () => guarded(ctx, 'list_workflows', async () => {
        await needWorkflows(ctx);
        const r = await onBranch(ctx, () => ctx.wf.list(ctx.tenant));
        return { result: r, detail: 'list workflow definitions', targets: ['workflow_definitions'] };
    }));
    server.registerTool('get_workflow', {
        description: 'Read one workflow definition with its steps.',
        inputSchema: { id: z.string().min(1).max(64) },
    }, ({ id }) => guarded(ctx, 'get_workflow', async () => {
        await needWorkflows(ctx);
        const r = await onBranch(ctx, () => ctx.wf.get(ctx.tenant, id));
        return { result: r, detail: `read workflow ${id}`, targets: ['workflow_definitions'], rowCount: 1 };
    }));
    server.registerTool('list_workflow_runs', {
        description: 'List workflow runs (optionally for one definition), or read one run in detail with run_id. Starting or cancelling a run is never available through MCP.',
        inputSchema: { definition: z.string().min(1).max(64).optional(), run_id: z.string().min(1).max(64).optional() },
    }, ({ definition, run_id }) => guarded(ctx, 'list_workflow_runs', async () => {
        await needWorkflows(ctx);
        if (run_id) {
            const r = await onBranch(ctx, () => ctx.wf.runView(ctx.tenant, run_id));
            return { result: r, detail: `read workflow run ${run_id}`, targets: ['workflow_runs'], rowCount: 1 };
        }
        const r = await onBranch(ctx, () => ctx.wf.listRuns(ctx.tenant, definition));
        return { result: r, detail: `list workflow runs${definition ? ` of ${definition}` : ''}`, targets: ['workflow_runs'] };
    }));
    server.registerTool('save_workflow', {
        description: 'Create or update a workflow definition on the working branch (name, description, steps graph, optional start trigger). The definition only goes live after a human merges the data pull request; starting or cancelling a run is never available through MCP.',
        inputSchema: {
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/).optional(),
            name: z.string().min(1).max(80), description: z.string().max(500).optional(),
            graph: z.record(z.string(), z.unknown()), trigger: z.record(z.string(), z.unknown()).nullable().optional(),
        },
    }, ({ id, ...body }) => guarded(ctx, 'save_workflow', async () => {
        await needWorkflows(ctx);
        const r = await onBranch(ctx, () => ctx.wf.save(ctx.tenant, id, body, ctx.session.owner, !id));
        return { result: { created: !id, branch: b, ...r }, detail: `${id ? 'update' : 'create'} workflow ${id ?? r.definition.id}`, targets: ['workflow_definitions'], rowCount: 1 };
    }));
    server.registerTool('delete_workflow', {
        description: 'Delete a workflow definition on the working branch (refused while a run is active). Only live after human review.',
        inputSchema: { id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/) },
    }, ({ id }) => guarded(ctx, 'delete_workflow', async () => {
        await needWorkflows(ctx);
        const r = await onBranch(ctx, () => ctx.wf.remove(ctx.tenant, id));
        return { result: r, detail: `delete workflow ${id}`, targets: ['workflow_definitions'], rowCount: 1 };
    }));
    server.registerTool('test_workflow', {
        description: 'Test a workflow definition AS PREPARED ON THE WORKING BRANCH without executing anything: walks the validated graph with a sample event payload and reports what every step would do. No run is created, no branch, no write, no notification. Missing trigger payload keys are auto-filled with <placeholders> and listed.',
        inputSchema: { id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/), event: z.record(z.string(), z.unknown()).optional() },
    }, ({ id, event }) => guarded(ctx, 'test_workflow', async () => {
        await needWorkflows(ctx);
        const r = await onBranch(ctx, () => ctx.wf.dryRun(ctx.tenant, id, event));
        return { result: r, detail: `test workflow ${id} (dry run, nothing executed)`, targets: ['workflow_definitions'], rowCount: r.steps.length };
    }));
    server.registerTool('get_authn_config', { description: 'Read the sign-in (authentication) configuration as prepared on the working branch.' }, () => guarded(ctx, 'get_authn_config', async () => {
        const r = await onBranch(ctx, () => ctx.authn.workingConfig(ctx.tenant));
        return { result: r, detail: 'read sign-in configuration', targets: ['plugin_config'] };
    }));
    server.registerTool('save_authn_config', {
        description: 'Replace the sign-in (authentication) configuration on the working branch (methods, chains, levels). Validated against the methods catalogue; never changes the live sign-in until a human applies the data pull request. User enrollments and the outbox stay unreachable.',
        inputSchema: { config: z.record(z.string(), z.unknown()) },
    }, ({ config }) => guarded(ctx, 'save_authn_config', async () => {
        const saved = await onBranch(ctx, () => ctx.authn.saveConfig(ctx.tenant, config));
        return { result: saved, detail: 'save sign-in configuration', targets: ['plugin_config'], rowCount: 1 };
    }));
}
