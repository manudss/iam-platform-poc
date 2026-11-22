/**
 * lyam admin blocks (P0/P1/P2 of the admin-blocks brief): business reads, human approvals and tasks,
 * lifecycle writes on the run branch, roles, recertification campaigns (the IGA socle), and the P2
 * proposal-only blocks (policy and plugin changes are ALWAYS a human decision: these blocks only open a
 * task, they never apply a policy or plugin change themselves).
 *
 * Safety contract (same as the existing lyam-* blocks):
 *  - a READ block only reads (typed reads on a ref, no free-form query) and is categorized `computed`;
 *  - a WRITE block writes on the run branch (reviewed like every other data change) or durable
 *    operational state in the meta store (tasks, campaigns), and is categorized `real`: a test run only
 *    logs what it would do;
 *  - an approval block SUSPENDS the run on a durable task (authenticated decision, justification on
 *    refusal, anti-self-approval against the run starter, delegation and escalation): an approval is a
 *    decision by a person, it is never a permission to publish;
 *  - no secret ever transits a block: secrets stay server-side (the existing lyam-generate-password /
 *    set-temporary-password / send-secret-mail trio).
 */
import { createRequire } from 'node:module';
import { WorkflowSuspend } from '../workflows-iga/model.mjs';
import { APP_CONNECTOR_DDL } from '../app-connector/handlers.mjs';

const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
const bad = (msg) => { throw new BadRequestException(msg); };
const str = (v, what, max, required = true) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (required && !s) bad(`${what}: required`);
    if (s.length > max) bad(`${what}: ${max} characters maximum`);
    return s;
};
const userId = (v, what) => { const x = str(v, what, 64); if (!/\{\{/.test(x) && !/^[a-z0-9][a-z0-9._@-]{0,63}$/.test(x)) bad(`${what}: not a valid user id`); return x; };
const idf = (v, what) => { const x = str(v, what, 64); if (!/\{\{/.test(x) && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(x)) bad(`${what}: lowercase letters, digits and hyphens`); return x; };
const num = (v, what, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) bad(`${what}: a number between ${min} and ${max}`); return Math.floor(n); };
const jsonObj = (v, what) => {
    if (v === undefined || v === null || v === '') return {};
    if (typeof v === 'object' && !Array.isArray(v)) return v;
    try { const x = JSON.parse(String(v)); if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error('not an object'); return x; } catch { bad(`${what}: a JSON object`); }
};
const need = (svc, what) => { if (!svc) bad(`${what}: this service is not available on this server`); return svc; };
/** The ref a read targets: the run's base branch (default), or the run's own working branch. */
const readRef = (ctx, cfg) => {
    const r = str(cfg.ref, 'ref', 80, false);
    if (r === 'run') return ctx.runBranch ?? ctx.baseBranch;
    if (r && !/^[A-Za-z0-9][A-Za-z0-9/_-]{0,79}$/.test(r)) bad('ref: a branch name (letters, digits, / _ -)');
    return r || ctx.baseBranch || 'main';
};

// ---- P0: human approvals and tasks -------------------------------------------------------------------

const lyamRequestApproval = {
    type: 'lyam-request-approval', family: 'lyam', label: 'Request an approval', simulated: false, category: 'real',
    description: 'Creates a durable approval task for a person (or a pool) and SUSPENDS the run until the decision. The decision is authenticated, a refusal needs a justification, and the person who started the run can never approve their own request. Overdue tasks remind once, then escalate. A test run only logs the request.',
    fields: [
        { key: 'title', label: 'Title', type: 'string', required: true, help: 'what the decider reviews, e.g. "Access for {{event.subject}}"' },
        { key: 'kind', label: 'Kind', type: 'string', default: 'approval', help: 'approval, certification... (lowercase, 1..30)' },
        { key: 'assignee', label: 'Decider', type: 'string', required: true, help: 'a user id, "manager" (the subject\'s manager) or "admin" (an administrator)' },
        { key: 'subject', label: 'Subject (for "manager")', type: 'string' },
        { key: 'decisions', label: 'Choices (comma-separated)', type: 'string', default: 'approved,refused' },
        { key: 'context', label: 'Context (JSON, shown to the decider)', type: 'text' },
        { key: 'dueInHours', label: 'Deadline (hours, optional)', type: 'number' },
        { key: 'escalateTo', label: 'Escalate to (user id, optional)', type: 'string' },
    ],
    outputs: [
        { key: 'taskId', description: 'The durable task id' },
        { key: 'decision', description: 'The recorded decision (one of the choices)' },
        { key: 'decidedBy', description: 'Who decided (the authenticated subject)' },
        { key: 'justification', description: 'The justification (required for a refusal)' },
    ],
    validate(cfg) {
        const decisions = str(cfg.decisions, 'lyam-request-approval.decisions', 120, false).split(',').map((x) => x.trim()).filter(Boolean);
        if (decisions.length && !decisions.every((d) => /^[a-z0-9][a-z0-9-]{0,30}$/.test(d))) bad('lyam-request-approval.decisions: comma-separated lowercase words');
        return {
            title: str(cfg.title, 'lyam-request-approval.title', 200),
            kind: str(cfg.kind, 'lyam-request-approval.kind', 30, false) || 'approval',
            assignee: str(cfg.assignee, 'lyam-request-approval.assignee', 64),
            subject: str(cfg.subject, 'lyam-request-approval.subject', 64, false) || undefined,
            decisions: decisions.length ? decisions : ['approved', 'refused'],
            context: jsonObj(cfg.context, 'lyam-request-approval.context'),
            dueInHours: cfg.dueInHours ? num(cfg.dueInHours, 'lyam-request-approval.dueInHours', 1, 8760) : undefined,
            escalateTo: str(cfg.escalateTo, 'lyam-request-approval.escalateTo', 64, false) || undefined,
        };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-request-approval');
        // Resumed: read the recorded wait. A re-run of the step reuses the same task (idempotent by run step).
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (chk.state === 'decided' && t?.decision) {
                ctx.log(`decision recorded: "${t.decision}" by ${t.decided_by}${t.justification ? ` (${t.justification})` : ''}`);
                return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, justification: t.justification ?? '' };
            }
            if (t?.status === 'canceled') bad('lyam-request-approval: the task was canceled (the run cannot resume on a decision that will never come)');
            throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: c.kind });
        }
        let assignee = c.assignee;
        if (assignee === 'manager') {
            if (!c.subject) bad('lyam-request-approval: subject is required when the decider is "manager"');
            const u = await need(ctx.reads, 'lyam-request-approval').readUser(ctx.tenant, ctx.baseBranch ?? 'main', c.subject);
            assignee = u.manager ?? 'admin';
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would open task "${c.title}" for ${assignee} and wait`); return { taskId: 'test', decision: c.decisions[0], decidedBy: assignee, justification: '' }; }
        const t = await tasks.request({
            tenant: ctx.tenant, kind: c.kind, title: c.title,
            detail: { decisions: c.decisions, context: c.context, ...(c.subject ? { subject: c.subject } : {}) },
            assignee, dueInSeconds: c.dueInHours ? c.dueInHours * 3600 : undefined, escalateTo: c.escalateTo,
            preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId,
        });
        throw new WorkflowSuspend({ taskId: t.id, kind: c.kind });
    },
};

// ---- P0: business reads (typed, on a ref, never a free-form query) -------------------------------------

const readBlock = (type, label, description, fields, run) => ({ type, family: 'lyam', label, simulated: false, category: 'computed', description, fields, validate: (cfg) => cfg, run });

const lyamReadUser = readBlock('lyam-read-user', 'Read a user', 'Reads one user on a ref: identity, manager, department, email, login state, roles and profile field values.', [
    { key: 'id', label: 'User id', type: 'string', required: true },
    { key: 'ref', label: 'Ref (base or run)', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const u = await need(ctx.reads, 'lyam-read-user').readUser(ctx.tenant, readRef(ctx, ctx.config), userId(ctx.config.id, 'lyam-read-user.id'));
    ctx.log(`user ${u.id} (${u.displayName}): ${u.roles.length} role(s)`);
    return u;
});

const lyamSearchUsers = readBlock('lyam-search-users', 'Search users', 'Searches users on a ref (query, department, manager; paginated, capped).', [
    { key: 'query', label: 'Query', type: 'string' },
    { key: 'department', label: 'Department', type: 'string' },
    { key: 'manager', label: 'Manager id', type: 'string' },
    { key: 'limit', label: 'Limit (max 200)', type: 'number' },
    { key: 'offset', label: 'Offset', type: 'number' },
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-search-users').listUsers(ctx.tenant, readRef(ctx, ctx.config), { query: str(ctx.config.query, 'query', 120, false) || undefined, department: str(ctx.config.department, 'department', 80, false) || undefined, manager: str(ctx.config.manager, 'manager', 64, false) || undefined, limit: ctx.config.limit ? num(ctx.config.limit, 'limit', 1, 200) : undefined, offset: ctx.config.offset ? num(ctx.config.offset, 'offset', 0, 100000) : undefined });
    ctx.log(`${r.count} user(s) match`);
    return r;
});

const lyamListRoles = readBlock('lyam-list-roles', 'List roles', 'Lists the roles (label, sensitivity, assignment count) and the SoD rules on a ref.', [
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-list-roles').listRoles(readRef(ctx, ctx.config));
    ctx.log(`${r.roles.length} role(s), ${r.sodRules.length} SoD rule(s)`);
    return r;
});

const lyamListAssignments = readBlock('lyam-list-assignments', 'List assignments', 'Lists role assignments on a ref (filter by user or role; paginated, capped).', [
    { key: 'identity', label: 'User id', type: 'string' },
    { key: 'role', label: 'Role id', type: 'string' },
    { key: 'limit', label: 'Limit (max 1000)', type: 'number' },
    { key: 'offset', label: 'Offset', type: 'number' },
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-list-assignments').listAssignments(readRef(ctx, ctx.config), { identity: str(ctx.config.identity, 'identity', 64, false) || undefined, role: str(ctx.config.role, 'role', 64, false) || undefined, limit: ctx.config.limit ? num(ctx.config.limit, 'limit', 1, 1000) : undefined, offset: ctx.config.offset ? num(ctx.config.offset, 'offset', 0, 100000) : undefined });
    ctx.log(`${r.count} assignment(s)`);
    return r;
});

const lyamSimulateAssignment = readBlock('lyam-simulate-assignment', 'Simulate an assignment change', 'Computes the SoD conflicts a hypothetical grant/revoke would produce on a ref. Writes nothing.', [
    { key: 'grant', label: 'Grants (JSON [{identity, role}])', type: 'text' },
    { key: 'revoke', label: 'Revocations (JSON [{identity, role}])', type: 'text' },
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const arr = (v, what) => { const x = jsonObj(v, what); const a = Array.isArray(x) ? x : (Array.isArray(v) ? v : []); return a.map((y) => ({ identity: userId(y?.identity, `${what}.identity`), role: idf(y?.role, `${what}.role`) })); };
    const grant = Array.isArray(ctx.config.grant) ? ctx.config.grant : jsonObj(ctx.config.grant, 'grant');
    const revoke = Array.isArray(ctx.config.revoke) ? ctx.config.revoke : jsonObj(ctx.config.revoke, 'revoke');
    const g = (Array.isArray(grant) ? grant : []).map((y) => ({ identity: userId(y?.identity, 'grant.identity'), role: idf(y?.role, 'grant.role') }));
    const r = (Array.isArray(revoke) ? revoke : []).map((y) => ({ identity: userId(y?.identity, 'revoke.identity'), role: idf(y?.role, 'revoke.role') }));
    const out = await need(ctx.reads, 'lyam-simulate-assignment').simulateAssignments(readRef(ctx, ctx.config), g, r);
    ctx.log(`${out.conflictsCount} SoD conflict(s) after ${out.changes.granted} grant(s), ${out.changes.revoked} revocation(s)`);
    return out;
});

const lyamListOrganizations = readBlock('lyam-list-organizations', 'List organizations', 'Lists the organizations and their members on a ref.', [
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-list-organizations').listOrganizations(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.orgs.length} organization(s)`);
    return r;
});

const lyamListApplications = readBlock('lyam-list-applications', 'List applications', 'Lists the application connectors on a ref (protocol, enabled, allowed roles).', [
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-list-applications').listApplications(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.applications.length} application(s)`);
    return r;
});

const lyamReadProfileSchema = readBlock('lyam-read-profile-schema', 'Read the profile schema', 'Reads the declared profile fields and their admin settings on a ref. Never the values of a person.', [
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-read-profile-schema').profileSchema(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.valueKeys.length} field key(s) carry values`);
    return r;
});

const lyamReadRun = readBlock('lyam-read-run', 'Read a workflow run', 'Reads the state and step outputs of a run of this tenant (to chain workflows: the child run id from lyam-start-workflow).', [
    { key: 'runId', label: 'Run id', type: 'string', required: true },
], async (ctx) => {
    const r = await need(ctx.runs, 'lyam-read-run').get(ctx.tenant, str(ctx.config.runId, 'lyam-read-run.runId', 48));
    ctx.log(`run ${r.id}: ${r.status}`);
    return r;
});

// ---- P0: lifecycle and role writes (run branch, reviewed like every other change) -----------------------

const writeBlock = (type, label, description, fields, validate, run) => ({ type, family: 'lyam', label, simulated: false, category: 'real', description, fields, validate, run });

const lyamUpdateUser = writeBlock('lyam-update-user', 'Update a user', 'REAL write ON THE RUN BRANCH: updates the identity attributes (display name, department, manager, email). The change is reviewed and published like every other data change. A test run only logs it.', [
    { key: 'id', label: 'User id', type: 'string', required: true },
    { key: 'displayName', label: 'Display name', type: 'string' },
    { key: 'department', label: 'Department', type: 'string' },
    { key: 'manager', label: 'Manager id', type: 'string' },
    { key: 'email', label: 'Email', type: 'string' },
], (cfg) => ({ id: userId(cfg.id, 'lyam-update-user.id'), displayName: str(cfg.displayName, 'displayName', 120, false) || undefined, department: str(cfg.department, 'department', 80, false) || undefined, manager: str(cfg.manager, 'manager', 64, false) || undefined, email: str(cfg.email, 'email', 120, false) || undefined }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would update user "${c.id}" on the run branch`); return { id: c.id, updated: false }; }
    await ctx.branchWrite(async (db) => {
        const sets = [], vals = [];
        if (c.displayName !== undefined) { sets.push('display_name = ?'); vals.push(c.displayName); }
        if (c.department !== undefined) { sets.push('department = ?'); vals.push(c.department || null); }
        if (c.manager !== undefined) { sets.push('manager_id = ?'); vals.push(c.manager || null); }
        if (c.email !== undefined) { const [cols] = await db.query("select column_name from information_schema.columns where table_schema = database() and table_name = 'identities' and column_name = 'email'"); if (!(cols ?? []).length) bad('lyam-update-user: this schema has no identities.email column (the demo schema): the email change is refused, not silently dropped'); sets.push('email = ?'); vals.push(c.email || null); }
        if (!sets.length) bad('lyam-update-user: at least one attribute to update');
        const [r] = await db.query(`update identities set ${sets.join(', ')} where id = ?`, [...vals, c.id]);
        if (!Number(r?.affectedRows)) bad(`lyam-update-user: unknown identity "${c.id}" on the run branch`);
    }, `workflow: update user ${c.id}`);
    ctx.log(`user "${c.id}" updated on the run branch`);
    return { id: c.id, updated: true };
});

const lyamSetLoginEnabled = writeBlock('lyam-set-login-enabled', 'Enable or disable a login', 'REAL write ON THE RUN BRANCH: sets the login_enabled flag of an account (the account blocks of lyam-block-account act immediately; a login flag is versioned data and is reviewed like every other change).', [
    { key: 'id', label: 'User id', type: 'string', required: true },
    { key: 'enabled', label: 'Login enabled', type: 'select', options: ['yes', 'no'], default: 'yes', required: true },
], (cfg) => ({ id: userId(cfg.id, 'lyam-set-login-enabled.id'), enabled: str(cfg.enabled, 'enabled', 3) === 'yes' }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would set login_enabled=${c.enabled} for "${c.id}" on the run branch`); return { id: c.id, enabled: c.enabled, updated: false }; }
    await ctx.branchWrite(async (db) => {
        const [cols] = await db.query("select column_name from information_schema.columns where table_schema = database() and table_name = 'identities' and column_name = 'login_enabled'");
        if (!(cols ?? []).length) bad('lyam-set-login-enabled: this schema has no identities.login_enabled column (the demo schema): use lyam-block-account for an immediate operational block');
        const [r] = await db.query('update identities set login_enabled = ? where id = ?', [c.enabled ? 1 : 0, c.id]);
        if (!Number(r?.affectedRows)) bad(`lyam-set-login-enabled: unknown identity "${c.id}" on the run branch`);
    }, `workflow: ${c.enabled ? 'enable' : 'disable'} login ${c.id}`);
    ctx.log(`login ${c.enabled ? 'enabled' : 'disabled'} for "${c.id}" on the run branch`);
    return { id: c.id, enabled: c.enabled, updated: true };
});

const lyamCreateRole = writeBlock('lyam-create-role', 'Create a role', 'REAL write ON THE RUN BRANCH: creates a role (id, label, sensitivity). The change is reviewed and published like every other data change.', [
    { key: 'id', label: 'Role id', type: 'string', required: true },
    { key: 'label', label: 'Label', type: 'string', required: true },
    { key: 'sensitive', label: 'Sensitive', type: 'select', options: ['no', 'yes'], default: 'no' },
], (cfg) => ({ id: idf(cfg.id, 'lyam-create-role.id'), label: str(cfg.label, 'lyam-create-role.label', 80), sensitive: str(cfg.sensitive, 'sensitive', 3, false) === 'yes' }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would create role "${c.id}" on the run branch`); return { id: c.id, created: false }; }
    await ctx.branchWrite(async (db) => {
        const [ex] = await db.query('select id from roles where id = ?', [c.id]);
        if ((ex ?? []).length) bad(`lyam-create-role: the role "${c.id}" already exists (changing it, including its sensitivity, needs a controlled proposal, not a workflow upsert)`);
        await db.query('insert into roles (id, label, is_sensitive) values (?,?,?)', [c.id, c.label, c.sensitive ? 1 : 0]);
    }, `workflow: create role ${c.id}`);
    ctx.log(`role "${c.id}" written on the run branch`);
    return { id: c.id, created: true };
});

const lyamProposeRoleRemoval = {
    type: 'lyam-propose-role-removal', family: 'lyam', label: 'Propose a role removal', simulated: false, category: 'real',
    description: 'Opens an approval task for the removal of a role and SUSPENDS the run until the decision. The block never removes anything itself: an approval is a decision by a person, and the removal happens in a later step only after approval.',
    fields: [
        { key: 'role', label: 'Role id', type: 'string', required: true },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
        { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'decidedBy', description: 'Who decided' }],
    validate(cfg) {
        return { role: idf(cfg.role, 'lyam-propose-role-removal.role'), reason: str(cfg.reason, 'lyam-propose-role-removal.reason', 500), assignee: str(cfg.assignee, 'lyam-propose-role-removal.assignee', 64, false) || 'admin' };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-propose-role-removal');
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (chk.state === 'decided' && t?.decision) return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, justification: t.justification ?? '' };
            if (t?.status === 'canceled') bad('lyam-propose-role-removal: the task was canceled');
            throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'role-removal' });
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would propose the removal of role "${c.role}" to ${c.assignee}`); return { taskId: 'test', decision: 'approved', decidedBy: c.assignee, justification: '' }; }
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'role-removal', title: `Remove role "${c.role}"`, detail: { role: c.role, reason: c.reason, decisions: ['approved', 'refused'] }, assignee: c.assignee, preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        throw new WorkflowSuspend({ taskId: t.id, kind: 'role-removal' });
    },
};

// ---- P0: recertification campaigns (the IGA socle) -------------------------------------------------------

const lyamGrantAssignment = writeBlock('lyam-grant-assignment', 'Grant a role assignment', 'REAL write ON THE RUN BRANCH: grants a role to an identity (idempotent). The identity and the role must exist. The grant is reviewed and published like every other data change.', [
    { key: 'identity', label: 'Identity id', type: 'string', required: true },
    { key: 'role', label: 'Role id', type: 'string', required: true },
], (cfg) => ({ identity: userId(cfg.identity, 'lyam-grant-assignment.identity'), role: idf(cfg.role, 'lyam-grant-assignment.role') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would grant "${c.role}" to "${c.identity}" on the run branch`); return { identity: c.identity, role: c.role, granted: false }; }
    let granted = false, sensitive = false, before = [];
    await ctx.branchWrite(async (db) => {
        const [u] = await db.query('select id from identities where id = ?', [c.identity]);
        if (!(u ?? []).length) bad(`lyam-grant-assignment: unknown identity "${c.identity}"`);
        const [r] = await db.query('select id, is_sensitive from roles where id = ?', [c.role]);
        if (!(r ?? []).length) bad(`lyam-grant-assignment: unknown role "${c.role}"`);
        sensitive = !!r[0].is_sensitive;
        const [cur] = await db.query('select role_id from assignments where identity_id = ? order by role_id', [c.identity]);
        before = (cur ?? []).map((x) => x.role_id);
        // SoD guard BEFORE the write: a grant that would put two conflicting roles on the identity is
        // refused here - the branch never carries the conflict, the human publication is not a loophole.
        const [viol] = await db.query('select r.role_a as roleA, r.role_b as roleB from assignments a join sod_rules r on (r.role_a = a.role_id and r.role_b = ?) or (r.role_b = a.role_id and r.role_a = ?) where a.identity_id = ?', [c.role, c.role, c.identity]);
        if ((viol ?? []).length) bad(`lyam-grant-assignment: granting "${c.role}" to "${c.identity}" would violate the segregation of duties (${viol[0].roleA} + ${viol[0].roleB}): refused BEFORE any write`);
        const [w] = await db.query('insert ignore into assignments (identity_id, role_id) values (?,?)', [c.identity, c.role]);
        granted = Number(w?.affectedRows ?? 0) > 0;
    }, `workflow: grant ${c.role} to ${c.identity}`);
    if (sensitive) ctx.log(`"${c.role}" is a SENSITIVE role: the grant stays on the run branch and lands only through a human publication review`);
    ctx.log(granted ? `"${c.role}" granted to "${c.identity}" on the run branch` : `"${c.identity}" already holds "${c.role}": nothing to grant`);
    // The explicit diff the human review relies on: the roles before, the roles after.
    return { identity: c.identity, role: c.role, granted, sensitive, diff: { before, after: granted ? [...before, c.role].sort() : before } };
});

const lyamRevokeAssignment = writeBlock('lyam-revoke-assignment', 'Revoke a role assignment', 'REAL write ON THE RUN BRANCH: removes a role from an identity (idempotent: an absent assignment is reported, not an error). The identity must exist. The revocation is reviewed and published like every other data change.', [
    { key: 'identity', label: 'Identity id', type: 'string', required: true },
    { key: 'role', label: 'Role id', type: 'string', required: true },
], (cfg) => ({ identity: userId(cfg.identity, 'lyam-revoke-assignment.identity'), role: idf(cfg.role, 'lyam-revoke-assignment.role') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would revoke "${c.role}" from "${c.identity}" on the run branch`); return { identity: c.identity, role: c.role, revoked: false }; }
    let revoked = false;
    await ctx.branchWrite(async (db) => {
        const [u] = await db.query('select id from identities where id = ?', [c.identity]);
        if (!(u ?? []).length) bad(`lyam-revoke-assignment: unknown identity "${c.identity}"`);
        const [w] = await db.query('delete from assignments where identity_id = ? and role_id = ?', [c.identity, c.role]);
        revoked = Number(w?.affectedRows ?? 0) > 0;
    }, `workflow: revoke ${c.role} from ${c.identity}`);
    ctx.log(revoked ? `"${c.role}" revoked from "${c.identity}" on the run branch` : `"${c.identity}" did not hold "${c.role}": nothing to revoke`);
    return { identity: c.identity, role: c.role, revoked };
});

const igaCreateCampaign = writeBlock('iga-create-campaign', 'IGA: create a recertification campaign', 'REAL: snapshots the scope on a ref (users in scope with their current roles) and creates the campaign. Durable operational state in the meta store. A test run only logs it.', [
    { key: 'name', label: 'Campaign name', type: 'string', required: true },
    { key: 'kind', label: 'Kind', type: 'select', options: ['user-access', 'role-membership', 'application-access'], default: 'user-access' },
    { key: 'department', label: 'Scope: department', type: 'string' },
    { key: 'role', label: 'Scope: role id', type: 'string' },
    { key: 'users', label: 'Scope: user ids (comma-separated)', type: 'string' },
    { key: 'ref', label: 'Snapshot ref', type: 'string', default: 'main' },
], (cfg) => ({ name: str(cfg.name, 'iga-create-campaign.name', 120), kind: str(cfg.kind, 'iga-create-campaign.kind', 24, false) || 'user-access', department: str(cfg.department, 'department', 80, false) || undefined, role: str(cfg.role, 'role', 64, false) || undefined, users: str(cfg.users, 'users', 2000, false) || undefined, ref: str(cfg.ref, 'iga-create-campaign.ref', 80, false) || 'main', scope: { department: str(cfg.department, 'department', 80, false) || undefined, role: str(cfg.role, 'role', 64, false) || undefined, users: str(cfg.users, 'users', 2000, false) ? str(cfg.users, 'users', 2000).split(',').map((x) => x.trim()).filter(Boolean) : undefined } }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would snapshot the campaign "${c.name}" on ${c.ref}`); return { id: 'test', name: c.name, status: 'test' }; }
    const camp = await need(ctx.iga, 'iga-create-campaign').createCampaign(ctx.tenant, `workflow:${ctx.runId}`, c);
    ctx.log(`campaign "${camp.name}" (${camp.id}) created on ${camp.ref}`);
    return camp;
});

const igaListItems = readBlock('iga-list-items', 'IGA: list campaign items', 'Lists the items of a campaign (optionally one state: pending, approved, denied, remediation-prepared, remediated, requeued).', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
    { key: 'state', label: 'State', type: 'string' },
], async (ctx) => {
    const r = await need(ctx.iga, 'iga-list-items').listItems(ctx.tenant, str(ctx.config.campaignId, 'iga-list-items.campaignId', 48), str(ctx.config.state, 'state', 24, false) || undefined);
    ctx.log(`${r.items.length} item(s)`);
    return r;
});

const igaOpenReviewTasks = writeBlock('iga-open-review-tasks', 'IGA: open the review tasks', 'REAL: opens one durable review task per pending campaign item (idempotent per item) for the item manager, the iga pool or a named reviewer. A test run only logs it.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
    { key: 'assignTo', label: 'Decider (user id, "manager" or "iga")', type: 'string', default: 'manager' },
], (cfg) => ({ campaignId: str(cfg.campaignId, 'iga-open-review-tasks.campaignId', 48), assignTo: str(cfg.assignTo, 'assignTo', 64, false) || 'manager' }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would open the review tasks of campaign ${c.campaignId}`); return { campaign: c.campaignId, opened: 0, tasks: [] }; }
    const r = await need(ctx.iga, 'iga-open-review-tasks').openReviewTasks(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, { assignTo: c.assignTo, runId: ctx.runId });
    ctx.log(`${r.opened} review task(s) open for campaign ${c.campaignId}`);
    return r;
});

const igaAwaitDecisions = {
    type: 'iga-await-decisions', family: 'lyam', label: 'IGA: await the review decisions', simulated: false, category: 'real',
    description: 'SUSPENDS the run until every review task of the campaign is decided, then records the decisions on the items (a self-review re-queues the item to the iga pool). Idempotent: a re-kick only records what is new.',
    fields: [{ key: 'campaignId', label: 'Campaign id', type: 'string', required: true }],
    outputs: [{ key: 'decisions', description: 'The recorded decisions per item' }, { key: 'open', description: 'Tasks still open (while waiting)' }],
    validate(cfg) { return { campaignId: str(cfg.campaignId, 'iga-await-decisions.campaignId', 48) }; },
    async run(ctx) {
        const c = ctx.config;
        const iga = need(ctx.iga, 'iga-await-decisions');
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would await the decisions of campaign ${c.campaignId}`); return { decisions: [], open: 0 }; }
        const { tasks: campaignTasks } = await iga.reviewTasks(ctx.tenant, c.campaignId);
        if (!campaignTasks.length) bad(`iga-await-decisions: no review task opened for campaign ${c.campaignId} (iga-open-review-tasks must run first)`);
        const open = campaignTasks.filter((t) => t.status === 'open');
        if (open.length) { ctx.log(`${open.length} review task(s) still open: the run waits`); throw new WorkflowSuspend({ kind: 'iga-review', campaignId: c.campaignId, taskIds: open.map((t) => t.id).join(',') }); }
        const rec = await iga.recordTaskDecisions(ctx.tenant, campaignTasks.map((t) => t.id));
        ctx.log(`${rec.recorded.filter((r) => r.recorded).length} decision(s) recorded for campaign ${c.campaignId}`);
        return { decisions: rec.recorded, open: 0 };
    },
};

const igaPrepareRemediation = writeBlock('iga-prepare-remediation', 'IGA: prepare the remediation', 'REAL: for every denied item, prepares the remediation actions (revoke the reviewed roles) after a FRESH snapshot check: roles changed since the campaign = conflict, nothing prepared for that item.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
], (cfg) => ({ campaignId: str(cfg.campaignId, 'iga-prepare-remediation.campaignId', 48) }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would prepare the remediation of campaign ${c.campaignId}`); return { campaign: c.campaignId, remediation: [] }; }
    const r = await need(ctx.iga, 'iga-prepare-remediation').prepareRemediation(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, {});
    ctx.log(`${r.remediation.filter((x) => x.actions).length} item(s) prepared, ${r.remediation.filter((x) => x.conflict).length} conflict(s)`);
    return r;
});

const igaCloseCampaign = {
    type: 'iga-close-campaign', family: 'lyam', label: 'IGA: close the campaign', simulated: false, category: 'real',
    description: 'REAL: closes the campaign with its complete evidence file (scope, items, decisions, remediation, refs, digest). Strict: an undecided item or a denied item without applied remediation blocks the closure. An incomplete closure is possible ONLY through a human exception: the block opens a decision task for the IGA pool with the unresolved items, and the closing evidence records who authorized it and why.',
    fields: [{ key: 'campaignId', label: 'Campaign id', type: 'string', required: true }],
    outputs: [{ key: 'campaign', description: 'The campaign id' }, { key: 'status', description: 'closed' }, { key: 'evidence', description: 'The evidence file' }],
    validate(cfg) { return { campaignId: str(cfg.campaignId, 'iga-close-campaign.campaignId', 48) }; },
    async run(ctx) {
        const c = ctx.config;
        const iga = need(ctx.iga, 'iga-close-campaign');
        if (ctx.resumeWait?.taskId) {
            const chk = await need(ctx.tasks, 'iga-close-campaign').check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (chk.state === 'decided' && t?.decision === 'approved') {
                const approvedUnresolved = Array.isArray(t?.detail?.unresolved) ? t.detail.unresolved.map((u) => u?.item).filter(Boolean) : [];
                const r = await iga.close(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, { exception: { by: t.decided_by, justification: t.justification, approvedUnresolved } });
                ctx.log(`campaign ${c.campaignId} closed with a human exception authorized by ${t.decided_by} (digest ${String(r.evidence?.digest).slice(0, 12)}...)`);
                return r;
            }
            if (t?.status === 'canceled') bad('iga-close-campaign: the closure exception task was canceled');
            if (chk.state === 'decided') bad(`iga-close-campaign: the closure exception was refused${t?.justification ? `: ${t.justification}` : ''}`);
            throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'iga-close-campaign' });
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would close campaign ${c.campaignId}`); return { campaign: c.campaignId, status: 'test' }; }
        try {
            const r = await iga.close(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, {});
            ctx.log(`campaign ${c.campaignId} closed (digest ${String(r.evidence?.digest).slice(0, 12)}...)`);
            return r;
        } catch (e) {
            const status = typeof e?.getStatus === 'function' ? e.getStatus() : e?.status;
            if (status !== 409 || !/not complete/.test(e?.message ?? '')) throw e;
            const { items } = await iga.listItems(ctx.tenant, c.campaignId);
            const unresolved = items.filter((i) => ['pending', 'requeued', 'denied', 'remediation-prepared'].includes(i.state)).map((i) => ({ item: i.id, identity: i.identity, state: i.state }));
            const t = await need(ctx.tasks, 'iga-close-campaign').request({ tenant: ctx.tenant, kind: 'iga-close-exception', title: `Close campaign ${c.campaignId} with ${unresolved.length} unresolved item(s)`, detail: { campaignId: c.campaignId, unresolved, requireJustification: true, decisions: ['approved', 'refused'] }, assignee: 'iga', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
            ctx.log(`campaign incomplete: closure exception task ${t.id} opened for the IGA pool`);
            throw new WorkflowSuspend({ taskId: t.id, kind: 'iga-close-campaign' });
        }
    },
};

const igaMarkRemediated = writeBlock('iga-mark-remediated', 'IGA: record an applied remediation', 'REAL: records that the remediation of an item was APPLIED (the calling workflow applied it on its run branch, e.g. with revoke steps; the run id is the proof). A decision alone never marks an item remediated.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
    { key: 'item', label: 'Item id', type: 'string', required: true },
    { key: 'runId', label: 'Proof: remediation run id (default: this run)', type: 'string' },
    { key: 'note', label: 'Note', type: 'string' },
], (cfg) => ({ campaignId: str(cfg.campaignId, 'iga-mark-remediated.campaignId', 48), item: str(cfg.item, 'iga-mark-remediated.item', 48), runId: str(cfg.runId, 'iga-mark-remediated.runId', 40, false), note: str(cfg.note, 'note', 500, false) }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would record the remediation of item ${c.item}`); return { item: c.item, state: 'test' }; }
    const r = await need(ctx.iga, 'iga-mark-remediated').markRemediated(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, c.item, { runId: c.runId || ctx.runId, note: c.note });
    ctx.log(`item ${c.item} remediated (proof run ${c.runId || ctx.runId}, verified on the campaign ref)`);
    return r;
});

const igaReadCampaign = readBlock('iga-read-campaign', 'IGA: read a campaign', 'Reads a campaign: scope, status, and the evidence file once closed.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
], async (ctx) => {
    const r = await need(ctx.iga, 'iga-read-campaign').getCampaign(ctx.tenant, str(ctx.config.campaignId, 'iga-read-campaign.campaignId', 48));
    ctx.log(`campaign ${r.id}: ${r.status}`);
    return r;
});

// ---- P1: organizations, applications, auth, sub-workflows -------------------------------------------------

const lyamCreateOrganization = writeBlock('lyam-create-organization', 'Create an organization', 'REAL write ON THE RUN BRANCH: creates (or renames) an organization. Reviewed like every other data change.', [
    { key: 'id', label: 'Organization id', type: 'string', required: true },
    { key: 'name', label: 'Name', type: 'string', required: true },
    { key: 'parent', label: 'Parent id (optional)', type: 'string' },
], (cfg) => ({ id: idf(cfg.id, 'lyam-create-organization.id'), name: str(cfg.name, 'lyam-create-organization.name', 80), parent: str(cfg.parent, 'parent', 64, false) || null }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would create organization "${c.id}" on the run branch`); return { id: c.id, created: false }; }
    await ctx.branchWrite(async (db) => {
        await db.query('create table if not exists organizations (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, parent_id varchar(32) null, primary key (tenant, id))');
        await db.query('insert into organizations (tenant, id, name, parent_id) values (?,?,?,?) on duplicate key update name = values(name), parent_id = values(parent_id)', [ctx.tenant, c.id, c.name, c.parent]);
    }, `workflow: create organization ${c.id}`);
    ctx.log(`organization "${c.id}" written on the run branch`);
    return { id: c.id, created: true };
});

const lyamAssignOrganization = writeBlock('lyam-assign-organization', 'Assign a user to an organization', 'REAL write ON THE RUN BRANCH: adds a user to an organization. Reviewed like every other data change.', [
    { key: 'subject', label: 'User id', type: 'string', required: true },
    { key: 'org', label: 'Organization id', type: 'string', required: true },
], (cfg) => ({ subject: userId(cfg.subject, 'lyam-assign-organization.subject'), org: idf(cfg.org, 'lyam-assign-organization.org') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would assign "${c.subject}" to organization "${c.org}" on the run branch`); return { subject: c.subject, org: c.org, assigned: false }; }
    await ctx.branchWrite(async (db) => {
        await db.query('create table if not exists org_memberships (tenant varchar(32) not null, subject varchar(32) not null, org_id varchar(32) not null, primary key (tenant, subject, org_id))');
        const [o] = await db.query('select id from organizations where tenant = ? and id = ?', [ctx.tenant, c.org]);
        if (!(o ?? []).length) bad(`lyam-assign-organization: unknown organization "${c.org}" on the run branch`);
        const [u] = await db.query('select id from identities where id = ?', [c.subject]);
        if (!(u ?? []).length) bad(`lyam-assign-organization: unknown identity "${c.subject}" on the run branch`);
        await db.query('insert ignore into org_memberships (tenant, subject, org_id) values (?,?,?)', [ctx.tenant, c.subject, c.org]);
    }, `workflow: assign ${c.subject} to organization ${c.org}`);
    ctx.log(`"${c.subject}" assigned to organization "${c.org}" on the run branch`);
    return { subject: c.subject, org: c.org, assigned: true };
});

const lyamCreateApplication = writeBlock('lyam-create-application', 'Create an application connector', 'REAL write ON THE RUN BRANCH: creates a disabled application connector (protocol and config). Secrets are NEVER written by a workflow: a connector references a server-side secret (secret_ref) that an administrator fills in the console. Reviewed like every other data change.', [
    { key: 'id', label: 'Application id', type: 'string', required: true },
    { key: 'name', label: 'Name', type: 'string', required: true },
    { key: 'description', label: 'Description', type: 'string' },
    { key: 'protocol', label: 'Protocol', type: 'select', options: ['saml', 'oidc'], default: 'oidc' },
    { key: 'config', label: 'Config (JSON, no secrets)', type: 'text' },
], (cfg) => {
    const conf = jsonObj(cfg.config, 'lyam-create-application.config');
    const deepScan = (o, path) => { for (const [k, v] of Object.entries(o ?? {})) { const p = path ? `${path}.${k}` : k; if (/secret|password|token|private.?key|credential/i.test(k) && k !== 'secret_ref' && v !== null && v !== undefined && v !== '') bad(`lyam-create-application.config.${p}: secrets never transiting a workflow (use a server-side secret_ref)`); if (typeof v === 'object' && v !== null) deepScan(v, p); } };
    deepScan(conf, '');
    return { id: idf(cfg.id, 'lyam-create-application.id'), name: str(cfg.name, 'lyam-create-application.name', 80), description: str(cfg.description, 'description', 240, false), protocol: str(cfg.protocol, 'protocol', 8, false) || 'oidc', config: conf };
}, async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would create application "${c.id}" on the run branch`); return { id: c.id, created: false }; }
    await ctx.branchWrite(async (db) => {
        await db.query(APP_CONNECTOR_DDL); // the app-connector plugin owns this schema: never a divergent copy
        const [ex] = await db.query('select id from app_connectors where tenant = ? and id = ?', [ctx.tenant, c.id]);
        if ((ex ?? []).length) bad(`lyam-create-application: the application "${c.id}" already exists (changing its protocol or config could hijack redirects: do it in the console after review)`);
        await db.query('insert into app_connectors (tenant, id, name, description, protocol, enabled, config) values (?,?,?,?,?,0,?)', [ctx.tenant, c.id, c.name, c.description, c.protocol, JSON.stringify(c.config)]);
    }, `workflow: create application ${c.id}`);
    ctx.log(`application "${c.id}" written on the run branch (disabled: an administrator enables it after review)`);
    return { id: c.id, created: true };
});

const lyamCheckAccountBlocks = readBlock('lyam-check-account-blocks', 'Read the account blocks in force', 'Reads the blocks in force on an account (operational state, live). A guard before a secret mail or an unblock.', [
    { key: 'subject', label: 'User id', type: 'string', required: true },
], async (ctx) => {
    const blocks = await need(ctx.accounts, 'lyam-check-account-blocks').activeBlocks(ctx.tenant, userId(ctx.config.subject, 'lyam-check-account-blocks.subject'));
    ctx.log(`${blocks.length} block(s) in force on "${ctx.config.subject}"`);
    return { subject: ctx.config.subject, blocks, blocked: blocks.length > 0 };
});

const lyamStartWorkflow = writeBlock('lyam-start-workflow', 'Start a sub-workflow', 'REAL: starts another workflow of this tenant as a child run (input as JSON). The child run is independent: use lyam-read-run to follow its state. A test run only logs it.', [
    { key: 'workflowId', label: 'Workflow id', type: 'string', required: true },
    { key: 'input', label: 'Input (JSON)', type: 'text' },
], (cfg) => ({ workflowId: str(cfg.workflowId, 'lyam-start-workflow.workflowId', 64), input: jsonObj(cfg.input, 'lyam-start-workflow.input') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would start workflow "${c.workflowId}"`); return { runId: 'test', started: false }; }
    const r = await need(ctx.runs, 'lyam-start-workflow').start(ctx.tenant, c.workflowId, c.input, `workflow:${ctx.runId}`);
    ctx.log(`child run ${r.id} started for workflow "${c.workflowId}"`);
    return { runId: r.id, started: true };
});

// ---- P2: policies, plugins, delegations (proposal-only) ----------------------------------------------------

const lyamValidatePolicy = readBlock('lyam-validate-policy', 'Validate a policy (Policy Studio)', 'Validates a policy definition with the Policy Studio (no write): the same errors the console shows.', [
    { key: 'policy', label: 'Policy (JSON)', type: 'text', required: true },
], async (ctx) => {
    const r = await need(ctx.policies, 'lyam-validate-policy').validate(ctx.tenant, jsonObj(ctx.config.policy, 'lyam-validate-policy.policy'));
    ctx.log(r.valid ? 'the policy is valid' : `${(r.errors ?? []).length} error(s)`);
    return r;
});

const proposeBlock = (type, label, description, fields, detail) => ({
    type, family: 'lyam', label, simulated: false, category: 'real', description,
    fields,
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'decidedBy', description: 'Who decided' }],
    validate(cfg) { const out = detail(cfg); for (const f of fields) if (!(f.key in out) && cfg[f.key] !== undefined && cfg[f.key] !== null && cfg[f.key] !== '') out[f.key] = cfg[f.key]; return out; },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, type);
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (chk.state === 'decided' && t?.decision) return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, justification: t.justification ?? '' };
            if (t?.status === 'canceled') bad(`${type}: the task was canceled`);
            throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: type });
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would open the proposal task "${c.title}"`); return { taskId: 'test', decision: 'approved', decidedBy: c.assignee, justification: '' }; }
        const t = await tasks.request({ tenant: ctx.tenant, kind: type, title: c.title, detail: { ...c.detail, decisions: ['approved', 'refused'] }, assignee: c.assignee ?? 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        throw new WorkflowSuspend({ taskId: t.id, kind: type });
    },
});

const lyamProposePolicyChange = proposeBlock('lyam-propose-policy-change', 'Propose a policy change', 'Opens an approval task for a policy change (the proposal JSON is attached). The block never applies anything: an administrator decides, and applies in the console. A change is never approved silently: the run starter cannot approve it.',
    [{ key: 'title', label: 'Title', type: 'string', required: true }, { key: 'proposal', label: 'Proposal (JSON)', type: 'text', required: true }, { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' }],
    (cfg) => ({ title: str(cfg.title, 'title', 200), detail: { proposal: jsonObj(cfg.proposal, 'proposal') }, assignee: str(cfg.assignee, 'assignee', 64, false) || 'admin' }));

const lyamReadPluginStates = readBlock('lyam-read-plugin-states', 'Read the plugin states', 'Lists the plugins (enabled or not, non-secret settings keys) on a ref.', [
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-read-plugin-states').pluginStates(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.plugins.length} plugin(s)`);
    return r;
});

const lyamProposePluginChange = proposeBlock('lyam-propose-plugin-change', 'Propose a plugin change', 'Opens an approval task for a plugin change (enable, disable, settings). The block never changes the plugin configuration itself: an administrator decides, and applies in the console.',
    [{ key: 'plugin', label: 'Plugin id', type: 'string', required: true }, { key: 'action', label: 'Action', type: 'select', options: ['enable', 'disable', 'settings'], required: true }, { key: 'proposal', label: 'Proposal (JSON, for settings)', type: 'text' }, { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' }],
    (cfg) => ({ title: `Plugin ${str(cfg.plugin, 'plugin', 60)}: ${str(cfg.action, 'action', 12)}`, detail: { plugin: str(cfg.plugin, 'plugin', 60), action: str(cfg.action, 'action', 12), proposal: jsonObj(cfg.proposal, 'proposal') }, assignee: str(cfg.assignee, 'assignee', 64, false) || 'admin' }));

const lyamListDelegations = readBlock('lyam-list-delegations', 'List the task delegations', 'Lists the open tasks of this tenant that were delegated (the decider named a replacement).', [], async (ctx) => {
    const inbox = await need(ctx.tasks, 'lyam-list-delegations').inbox(ctx.tenant, '', 'all');
    const delegations = inbox.tasks.filter((t) => t.status === 'open' && t.delegated_to).map((t) => ({ task: t.id, kind: t.kind, title: t.title, from: t.assignee, to: t.delegated_to, dueAt: t.due_at }));
    ctx.log(`${delegations.length} delegated task(s)`);
    return { delegations };
});

const lyamRevokeDelegationRequest = proposeBlock('lyam-revoke-delegation-request', 'Request a delegation revocation', 'Opens an approval task asking an administrator to revoke a delegation (the block never revokes it itself).',
    [{ key: 'task', label: 'Task id', type: 'string', required: true }, { key: 'reason', label: 'Reason', type: 'text', required: true }, { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' }],
    (cfg) => ({ title: `Revoke the delegation of task ${str(cfg.task, 'task', 48)}`, detail: { task: str(cfg.task, 'task', 48), reason: str(cfg.reason, 'reason', 500) }, assignee: str(cfg.assignee, 'assignee', 64, false) || 'admin' }));

const lyamReadDiff = {
    type: 'lyam-read-diff', family: 'lyam', label: 'Read the run branch diff', simulated: false, category: 'real',
    description: 'Reads the Dolt diff summary between the base ref and the run branch: exactly what a publication will review. Real only (a test run has no branch).',
    fields: [],
    outputs: [{ key: 'diff', description: 'The diff summary (tables, adds, removes, changes)' }],
    validate() { return {}; },
    async run(ctx) {
        const publish = need(ctx.publish, 'lyam-read-diff');
        if (ctx.test || ctx.dryRun) { ctx.log('test run: would read the run branch diff'); return { diff: null }; }
        if (!ctx.runBranch) bad('lyam-read-diff: this run has no data branch (simulated steps only)');
        const base = ctx.baseBranch ?? 'main';
        const diff = await publish.diff(base, ctx.runBranch);
        ctx.log(`diff ${base}..${ctx.runBranch} read`);
        return { diff };
    },
};

const lyamRequestPublish = {
    type: 'lyam-request-publish', family: 'lyam', label: 'Request the publication of the run branch', simulated: false, category: 'real',
    description: 'Opens (or reuses) the Dolt pull request reviewing the run branch. With await=yes the run SUSPENDS until an administrator approves the publication task (a refusal fails the run). The merge itself always stays a human action.',
    fields: [
        { key: 'title', label: 'Pull request title', type: 'string' },
        { key: 'await', label: 'Wait for the approval', type: 'select', options: ['yes', 'no'], default: 'yes' },
    ],
    outputs: [{ key: 'pullRequest', description: 'The pull request (id, source, target)' }, { key: 'reused', description: 'An open PR already existed' }, { key: 'decision', description: 'approved (when awaited)' }, { key: 'decidedBy', description: 'Who approved' }],
    validate(cfg) { return { title: str(cfg.title, 'title', 200, false), ['await']: str(cfg['await'], 'await', 3, false) === 'no' ? 'no' : 'yes' }; },
    async run(ctx) {
        const publish = need(ctx.publish, 'lyam-request-publish');
        const c = ctx.config;
        const awaitPub = c['await'] !== 'no';
        if (ctx.resumeWait?.taskId) {
            const tasks = need(ctx.tasks, 'lyam-request-publish');
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (t?.status === 'canceled') bad('lyam-request-publish: the publication task was canceled');
            const prId = Number(t?.detail?.pr?.id ?? 0);
            if (!prId) bad('lyam-request-publish: the wait carries no pull request id');
            // The REAL pull request state is the source of truth: a business approval alone never
            // equals an applied publication. merged = success; anything closed without merge = failure.
            const prView = await publish.status(ctx.tenant, prId);
            const prState = String(prView?.pullRequest?.status ?? 'open');
            // The real PR state moved BEFORE this wait was decided (merged or closed directly): settle the
            // orphan wait with the reason recorded (the audit row stays), then conclude from the PR state.
            if (prState !== 'open' && chk.state === 'open') await tasks.settleSystem(ctx.tenant, t.id, `workflow:${ctx.runId}`, `pull request #${prId} ${prState}: this wait is settled`);
            if (prState === 'merged') { ctx.log(`pull request #${prId} merged: the publication landed`); return { pullRequest: prView.pullRequest, reused: false, decision: 'approved', decidedBy: t?.decided_by ?? null, merged: true }; }
            if (prState !== 'open') bad(`lyam-request-publish: pull request #${prId} is ${prState} (closed without merge): the publication did not land`);
            if (t?.kind === 'publish-approval') {
                if (chk.state !== 'decided') throw new WorkflowSuspend({ taskId: t.id, kind: 'lyam-request-publish' });
                if (t.decision !== 'approved') bad(`lyam-request-publish: the publication was refused${t?.justification ? `: ${t.justification}` : ''}`);
                // Approved intent, PR still open: now wait for the actual merge. The watch task is overdue
                // on purpose (rescan): the cron re-kicks this run to re-read the real PR state.
                const w = await tasks.request({ tenant: ctx.tenant, kind: 'publish-merge-watch', title: `Merge pull request #${prId} (run ${ctx.runId})`, detail: { pr: t.detail.pr, rescan: true, requireJustification: true, decisions: ['merged', 'abandoned'] }, assignee: 'admin', preventSelfApproval: false, runId: ctx.runId, nodeId: ctx.nodeId, dueInSeconds: 300 });
                ctx.log(`publication approved by ${t.decided_by}: waiting for the actual merge of PR #${prId} (watch ${w.id})`);
                throw new WorkflowSuspend({ taskId: w.id, kind: 'lyam-request-publish' });
            }
            // merge-watch: a human "merged" marking while the PR is still open is a contradiction, not a wait.
            if (t?.decision === 'merged') bad(`lyam-request-publish: task ${t.id} says merged but pull request #${prId} is still open`);
            if (t?.decision === 'abandoned') bad(`lyam-request-publish: the publication was abandoned${t?.justification ? `: ${t.justification}` : ''}`);
            throw new WorkflowSuspend({ taskId: t.id, kind: 'lyam-request-publish' });
        }
        if (ctx.test || ctx.dryRun) { ctx.log('test run: would request the publication of the run branch'); return { pullRequest: { id: 0 }, reused: false, decision: awaitPub ? 'approved' : null, decidedBy: awaitPub ? 'test' : null }; }
        const { pullRequest: pr, reused } = await publish.request(ctx.tenant, ctx.runId, c.title || `Workflow run ${ctx.runId}`);
        ctx.log(`pull request #${pr.id} ${reused ? 'reused' : 'opened'} (${pr.source} -> ${pr.target})`);
        if (!awaitPub) return { pullRequest: pr, reused, decision: null, decidedBy: null };
        const t = await need(ctx.tasks, 'lyam-request-publish').request({ tenant: ctx.tenant, kind: 'publish-approval', title: `Publish run ${ctx.runId}: PR #${pr.id}`, detail: { pr, rescan: true, decisions: ['approved', 'refused'] }, assignee: 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId, dueInSeconds: 1800 });
        throw new WorkflowSuspend({ taskId: t.id, kind: 'lyam-request-publish' });
    },
};

export const LYAM_ADMIN_BLOCKS = [
    // P0
    lyamRequestApproval,
    lyamReadUser, lyamSearchUsers, lyamListRoles, lyamListAssignments, lyamSimulateAssignment, lyamListOrganizations, lyamListApplications, lyamReadProfileSchema,
    lyamUpdateUser, lyamSetLoginEnabled, lyamCreateRole, lyamProposeRoleRemoval,
    igaCreateCampaign, igaListItems, igaOpenReviewTasks, igaAwaitDecisions, igaPrepareRemediation, igaMarkRemediated, igaCloseCampaign, igaReadCampaign,
    lyamGrantAssignment, lyamRevokeAssignment,
    lyamReadDiff, lyamRequestPublish,
    // P1
    lyamCreateOrganization, lyamAssignOrganization, lyamCreateApplication, lyamCheckAccountBlocks, lyamStartWorkflow, lyamReadRun,
    // P2
    lyamValidatePolicy, lyamProposePolicyChange, lyamReadPluginStates, lyamProposePluginChange, lyamListDelegations, lyamRevokeDelegationRequest,
];
