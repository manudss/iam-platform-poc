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
import { createHash } from 'node:crypto';
import { WorkflowSuspend } from '../workflows-iga/model.mjs';
import { APP_CONNECTOR_DDL, build as buildAppConfig, appConnectorConfig } from '../app-connector/handlers.mjs';
import { csvToRows } from '../csv-connector/handlers.mjs';
import { scimToRows } from '../scim-connector/handlers.mjs';

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

const lyamReadUser = readBlock('lyam-read-user', 'Read a user', 'Reads one user on a ref: identity, manager, department, login state and roles. PII is opt-in: the email and the profile field values join the output ONLY when explicitly requested (they are persisted in the run history like every output).', [
    { key: 'id', label: 'User id', type: 'string', required: true },
    { key: 'ref', label: 'Ref (base or run)', type: 'select', options: ['base', 'run'], default: 'base' },
    { key: 'includeEmail', label: 'Also return the email (PII, persisted in the run history)', type: 'select', options: ['no', 'yes'], default: 'no' },
    { key: 'includeProfile', label: 'Also return the profile field values (PII, persisted)', type: 'select', options: ['no', 'yes'], default: 'no' },
], async (ctx) => {
    const u = await need(ctx.reads, 'lyam-read-user').readUser(ctx.tenant, readRef(ctx, ctx.config), userId(ctx.config.id, 'lyam-read-user.id'));
    ctx.log(`user ${u.id}: ${u.roles.length} role(s)`); // no displayName in the logs: not needed, and persisted
    // Minimal projection by default: the step output is persisted; email/profile values are opt-in.
    if (String(ctx.config.includeEmail ?? 'no') !== 'yes') delete u.email;
    if (String(ctx.config.includeProfile ?? 'no') !== 'yes') delete u.profileFields;
    return u;
});

const lyamSearchUsers = readBlock('lyam-search-users', 'Search users', 'Searches users on a ref (query, department, manager; paginated, capped).', [
    { key: 'query', label: 'Query', type: 'string' },
    { key: 'department', label: 'Department', type: 'string' },
    { key: 'manager', label: 'Manager id', type: 'string' },
    { key: 'limit', label: 'Limit (max 200)', type: 'number' },
    { key: 'offset', label: 'Offset', type: 'number' },
    { key: 'ref', label: 'Ref', type: 'select', options: ['base', 'run'], default: 'base' },
    { key: 'includeEmail', label: 'Also return emails (PII, persisted in the run history)', type: 'select', options: ['no', 'yes'], default: 'no' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-search-users').listUsers(ctx.tenant, readRef(ctx, ctx.config), { query: str(ctx.config.query, 'query', 120, false) || undefined, department: str(ctx.config.department, 'department', 80, false) || undefined, manager: str(ctx.config.manager, 'manager', 64, false) || undefined, limit: ctx.config.limit ? num(ctx.config.limit, 'limit', 1, 200) : undefined, offset: ctx.config.offset ? num(ctx.config.offset, 'offset', 0, 100000) : undefined });
    ctx.log(`${r.count} user(s) match`);
    // Minimal projection by default (the step output is persisted): emails are opt-in.
    if (String(ctx.config.includeEmail ?? 'no') !== 'yes') for (const u of r.users) delete u.email;
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

const lyamRevokeAssignment = writeBlock('lyam-revoke-assignment', 'Revoke a role assignment', 'REAL write ON THE RUN BRANCH: removes a role from an identity (idempotent: an absent assignment is reported, not an error). The identity must exist. The revocation is reviewed and published like every other data change. Give identity + role, OR a remediation action JSON (the loop item of a remediation loop).', [
    { key: 'identity', label: 'Identity id', type: 'string' },
    { key: 'role', label: 'Role id', type: 'string' },
    { key: 'action', label: 'OR a remediation action JSON (a loop item)', type: 'string' },
], (cfg) => {
    if (cfg.action !== undefined && String(cfg.action).trim()) {
        const raw = String(cfg.action).trim();
        if (/^\{\{.+\}\}$/.test(raw)) return { action: raw }; // a loop placeholder resolves at runtime
        let a; try { a = JSON.parse(raw); } catch { bad('lyam-revoke-assignment.action: not valid JSON'); }
        return { identity: userId(a?.identity, 'lyam-revoke-assignment.action.identity'), role: idf(a?.role, 'lyam-revoke-assignment.action.role') };
    }
    return { identity: userId(cfg.identity, 'lyam-revoke-assignment.identity'), role: idf(cfg.role, 'lyam-revoke-assignment.role') };
}, async (ctx) => {
    let c = ctx.config;
    if (c.action && !c.identity) {
        let a; try { a = JSON.parse(String(c.action)); } catch { bad('lyam-revoke-assignment.action: the loop item is not a remediation action JSON'); }
        c = { identity: userId(a?.identity, 'lyam-revoke-assignment.action.identity'), role: idf(a?.role, 'lyam-revoke-assignment.action.role') };
    }
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
    { key: 'dueInDays', label: 'Deadline in days (optional, 1 to 90)', type: 'string', help: 'A late review stays visible (see "IGA: read the late reviews") and is escalated once. Lateness never revokes or keeps an access by itself.' },
    { key: 'escalateTo', label: 'Escalate once to (optional: user id, "iga" or "admin")', type: 'string', help: 'Needs a deadline.' },
], (cfg) => {
    const d = str(cfg.dueInDays, 'iga-open-review-tasks.dueInDays', 3, false);
    if (d && !/^[0-9]{1,2}$/.test(d)) bad('iga-open-review-tasks.dueInDays: a whole number of days (1 to 90)');
    if (d && (Number(d) < 1 || Number(d) > 90)) bad('iga-open-review-tasks.dueInDays: a whole number of days (1 to 90)');
    const e = str(cfg.escalateTo, 'iga-open-review-tasks.escalateTo', 64, false);
    if (e && !d) bad('iga-open-review-tasks.escalateTo: needs dueInDays');
    return { campaignId: str(cfg.campaignId, 'iga-open-review-tasks.campaignId', 48), assignTo: str(cfg.assignTo, 'assignTo', 64, false) || 'manager', ...(d ? { dueInDays: d } : {}), ...(e ? { escalateTo: e } : {}) };
}, async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would open the review tasks of campaign ${c.campaignId}`); return { campaign: c.campaignId, opened: 0, tasks: [] }; }
    const r = await need(ctx.iga, 'iga-open-review-tasks').openReviewTasks(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, { assignTo: c.assignTo, runId: ctx.runId, ...(c.dueInDays ? { dueInDays: c.dueInDays } : {}), ...(c.escalateTo ? { escalateTo: c.escalateTo } : {}) });
    ctx.log(`${r.opened} review task(s) open for campaign ${c.campaignId}`);
    return r;
});

const igaAwaitDecisions = {
    type: 'iga-await-decisions', family: 'lyam', label: 'IGA: await the review decisions', simulated: false, category: 'real',
    description: 'SUSPENDS the run until every review task of the campaign is decided, then records the decisions on the items (a self-review re-queues the item to the iga pool). Idempotent: a re-kick only records what is new.',
    fields: [{ key: 'campaignId', label: 'Campaign id', type: 'string', required: true }],
    outputs: [{ key: 'decisions', description: 'The recorded decisions per item' }, { key: 'open', description: 'Tasks still open (while waiting)' }, { key: 'denied', description: 'How many items were denied (drives the remediation branch)' }],
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
        return { decisions: rec.recorded, open: 0, denied: rec.recorded.filter((r) => r.recorded === 'denied').length };
    },
};

const igaPrepareRemediation = writeBlock('iga-prepare-remediation', 'IGA: prepare the remediation', 'REAL: for every denied item, prepares the remediation actions (revoke the reviewed roles) after a FRESH snapshot check: roles changed since the campaign = conflict, nothing prepared for that item.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
], (cfg) => ({ campaignId: str(cfg.campaignId, 'iga-prepare-remediation.campaignId', 48) }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would prepare the remediation of campaign ${c.campaignId}`); return { campaign: c.campaignId, remediation: [] }; }
    const r = await need(ctx.iga, 'iga-prepare-remediation').prepareRemediation(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, {});
    const prepared = r.remediation.filter((x) => x.actions && !x.conflict);
    // Loop-ready flat forms: one entry per revoke action, one per denied identity (mark-remediated loops over it).
    const actions = prepared.flatMap((x) => (x.actions ?? []).filter((a) => a.type === 'revoke-role').map((a) => ({ item: x.item, identity: a.identity ?? x.identity, role: a.role })));
    const deniedItems = prepared.map((x) => x.identity);
    ctx.log(`${prepared.length} item(s) prepared (${actions.length} revoke action(s)), ${r.remediation.filter((x) => x.conflict).length} conflict(s)`);
    const conflictItems = r.remediation.filter((x) => x.conflict);
    return { ...r, actions, actionCount: actions.length, deniedItems, conflicts: conflictItems.length, conflictItems };
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

const igaReadOverdue = readBlock('iga-read-overdue', 'IGA: read the late reviews', 'Lists the open review tasks of a campaign whose deadline has passed (task, item, identity, current decider, whether it was escalated). Read only: lateness is made visible, nothing is revoked, kept or closed because of it.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
], async (ctx) => {
    const r = await need(ctx.iga, 'iga-read-overdue').overdueReviews(ctx.tenant, str(ctx.config.campaignId, 'iga-read-overdue.campaignId', 48));
    ctx.log(`campaign ${r.campaign}: ${r.overdue} late review(s)`);
    return r;
});

const igaReassignReviews = writeBlock('iga-reassign-review', 'IGA: replace an absent validator', 'REAL: moves the OPEN review tasks of a campaign from one decider to another (an absent validator). Decided tasks and closed campaigns are untouched; a task about the new decider is refused and reported, never silently skipped. The deadline is kept. A test run only logs it.', [
    { key: 'campaignId', label: 'Campaign id', type: 'string', required: true },
    { key: 'from', label: 'Absent validator (user id)', type: 'string', required: true },
    { key: 'to', label: 'Replacement (user id, "iga" or "admin")', type: 'string', required: true },
    { key: 'reason', label: 'Reason (kept on the task)', type: 'string' },
], (cfg) => ({ campaignId: str(cfg.campaignId, 'iga-reassign-review.campaignId', 48), from: userId(cfg.from, 'iga-reassign-review.from'), to: str(cfg.to, 'iga-reassign-review.to', 64), reason: str(cfg.reason, 'iga-reassign-review.reason', 200, false) || 'validator absent' }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would move the open review tasks of campaign ${c.campaignId} from "${c.from}" to "${c.to}"`); return { campaign: c.campaignId, from: c.from, to: c.to, reassigned: [], refused: [] }; }
    const r = await need(ctx.iga, 'iga-reassign-review').reassignReviewTasks(ctx.tenant, `workflow:${ctx.runId}`, c.campaignId, { from: c.from, to: c.to, reason: c.reason });
    ctx.log(`${r.reassigned.length} review task(s) moved, ${r.refused.length} refused`);
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

const proposeBlock = (type, label, description, fields, detail, kindOf) => ({
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
        const kind = (typeof kindOf === 'function' ? kindOf(c) : kindOf) ?? type;
        const t = await tasks.request({ tenant: ctx.tenant, kind, title: c.title, detail: { ...c.detail, decisions: ['approved', 'refused'] }, assignee: c.assignee ?? 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        throw new WorkflowSuspend({ taskId: t.id, kind });
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

/** A protection plugin: an authentication method or account protection (auth-*). The brief requires a
 *  REINFORCED validation to disable one or change its settings: whole admin pool, anti-self-approval, flagged task. */
const PROTECTION_PLUGIN = /^auth(-|$)/;
const isReinforcedPluginChange = (detail) => PROTECTION_PLUGIN.test(detail?.plugin ?? '') && (detail?.action === 'disable' || detail?.action === 'settings');
const lyamProposePluginChange = proposeBlock('lyam-propose-plugin-change', 'Propose a plugin change', 'Opens an approval task for a plugin change (enable, disable, settings). The block never changes the plugin configuration itself: an administrator decides, and applies in the console. Reinforced validation as the brief requires: disabling a protection (an auth-* plugin) or changing its settings is flagged reinforced in the task and always decided by the whole admin pool. Installing code or changing the permissions of a plugin is NOT offered by this block at all: that stays a human action in the console.',
    [{ key: 'plugin', label: 'Plugin id', type: 'string', required: true }, { key: 'action', label: 'Action', type: 'select', options: ['enable', 'disable', 'settings'], required: true }, { key: 'proposal', label: 'Proposal (JSON, for settings)', type: 'text' }, { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' }],
    (cfg) => {
        const plugin = str(cfg.plugin, 'plugin', 60), action = str(cfg.action, 'action', 12);
        const reinforced = isReinforcedPluginChange({ plugin, action });
        return { title: `Plugin ${plugin}: ${action}`, detail: { plugin, action, proposal: jsonObj(cfg.proposal, 'proposal'), ...(reinforced ? { reinforced: 'protection-change' } : {}) }, assignee: reinforced ? 'admin' : str(cfg.assignee, 'assignee', 64, false) || 'admin' };
    },
    (c) => isReinforcedPluginChange(c.detail) ? 'lyam-propose-plugin-change-reinforced' : 'lyam-propose-plugin-change');

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
        // No run branch = no data step ever wrote on this run (e.g. a remediation loop over ZERO
        // actions): opening a pull request would be a useless review, so the step ends as an explicit
        // skip, never as an empty PR and never as a silent success.
        if (!ctx.runBranch) { ctx.log('no data branch on this run (no step wrote anything): nothing to publish, no pull request opened'); return { skipped: true, reason: 'no data change on this run: nothing to publish', pullRequest: null, reused: false, decision: 'not-needed', decidedBy: null, merged: false }; }
        const { pullRequest: pr, reused } = await publish.request(ctx.tenant, ctx.runId, c.title || `Workflow run ${ctx.runId}`);
        ctx.log(`pull request #${pr.id} ${reused ? 'reused' : 'opened'} (${pr.source} -> ${pr.target})`);
        if (!awaitPub) return { pullRequest: pr, reused, decision: null, decidedBy: null };
        const t = await need(ctx.tasks, 'lyam-request-publish').request({ tenant: ctx.tenant, kind: 'publish-approval', title: `Publish run ${ctx.runId}: PR #${pr.id}`, detail: { pr, rescan: true, decisions: ['approved', 'refused'] }, assignee: 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId, dueInSeconds: 1800 });
        throw new WorkflowSuspend({ taskId: t.id, kind: 'lyam-request-publish' });
    },
};


// ===================== Completion of the brief's partial families (P1 #4 #7 #11, P2 #10, P1 #8) =============
// Same safety contract as above, and one distinction every description makes EXPLICITLY:
//  - a VERSIONED write lands on the run branch and is reviewed and published like every other data change;
//  - an IMMEDIATE effect (the re-enrollment request: unenroll + notification) applies at once, is audited,
//    and is NEVER reverted by a later merge or publication. A durable intent is recorded right before it:
//    a crash leaves the step in EXTERNAL_EFFECT_REVIEW_REQUIRED for a human, never a blind retry.

// ---- P1 #4: organizations, removal with impact control -----------------------------------------------------

const ORG_TABLES_DDL = [
    'create table if not exists organizations (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, parent_id varchar(32) null, primary key (tenant, id))',
    'create table if not exists org_memberships (tenant varchar(32) not null, subject varchar(32) not null, org_id varchar(32) not null, primary key (tenant, subject, org_id))',
];
/** The references an organization carries: its direct members and its child organizations. */
const orgImpactOf = (orgs, members, id) => {
    const direct = members.filter((m) => m.org === id).map((m) => m.subject).sort();
    const children = orgs.filter((o) => o.parent === id).map((o) => o.id).sort();
    return { members: direct, memberCount: direct.length, children, childCount: children.length };
};
const sameImpact = (a, b) => !!a && !!b && a.memberCount === b.memberCount && a.childCount === b.childCount && JSON.stringify(a.members) === JSON.stringify(b.members) && JSON.stringify(a.children) === JSON.stringify(b.children);

const lyamOrgImpact = readBlock('lyam-org-impact', 'Measure the impact of removing an organization', 'Reads the references an organization carries on a ref: its direct members and its child organizations. The control the brief asks before any removal: show the impact first.', [
    { key: 'id', label: 'Organization id', type: 'string', required: true },
    { key: 'ref', label: 'Ref (branch, default: the run base)', type: 'string' },
], async (ctx) => {
    const id = idf(ctx.config.id, 'lyam-org-impact.id');
    const r = await need(ctx.reads, 'lyam-org-impact').listOrganizations(ctx.tenant, readRef(ctx, ctx.config));
    const org = r.orgs.find((o) => o.id === id);
    if (!org) bad(`lyam-org-impact: unknown organization "${id}" on this ref`);
    const impact = orgImpactOf(r.orgs, r.members, id);
    ctx.log(`organization "${id}": ${impact.memberCount} direct member(s), ${impact.childCount} child organization(s)`);
    return { id, name: org.name, ...impact, removable: impact.childCount === 0 };
});

const lyamRemoveOrgMember = writeBlock('lyam-remove-org-member', 'Remove a member from an organization', 'REAL write ON THE RUN BRANCH: removes one organization membership (idempotent: an absent membership is reported, not an error). Reviewed and published like every other data change.', [
    { key: 'subject', label: 'User id', type: 'string', required: true },
    { key: 'org', label: 'Organization id', type: 'string', required: true },
], (cfg) => ({ subject: userId(cfg.subject, 'lyam-remove-org-member.subject'), org: idf(cfg.org, 'lyam-remove-org-member.org') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would remove "${c.subject}" from organization "${c.org}" on the run branch`); return { subject: c.subject, org: c.org, removed: false }; }
    let removed = false;
    await ctx.branchWrite(async (db) => {
        for (const ddl of ORG_TABLES_DDL) await db.query(ddl);
        const [r] = await db.query('delete from org_memberships where tenant = ? and subject = ? and org_id = ?', [ctx.tenant, c.subject, c.org]);
        removed = Number(r?.affectedRows ?? 0) > 0;
    }, `workflow: remove ${c.subject} from organization ${c.org}`);
    ctx.log(removed ? `"${c.subject}" removed from organization "${c.org}" on the run branch` : `"${c.subject}" was not a member of "${c.org}": nothing to remove`);
    return { subject: c.subject, org: c.org, removed };
});

const lyamProposeOrgRemoval = {
    type: 'lyam-propose-org-removal', family: 'lyam', label: 'Propose an organization removal', simulated: false, category: 'real',
    description: 'Opens an approval task SHOWING the organization references (direct members, child organizations), SUSPENDS the run until the decision, and only after approval removes the organization ON THE RUN BRANCH (versioned: reviewed and published like every other change). The references are re-read at apply time: if they changed since the approval, the removal is refused and must be proposed again. An organization that still has child organizations is never removed.',
    fields: [
        { key: 'id', label: 'Organization id', type: 'string', required: true },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
        { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'removed', description: 'Whether the organization was removed on the run branch' }],
    validate(cfg) {
        return { id: idf(cfg.id, 'lyam-propose-org-removal.id'), reason: str(cfg.reason, 'lyam-propose-org-removal.reason', 500), assignee: str(cfg.assignee, 'lyam-propose-org-removal.assignee', 64, false) || 'admin', ref: str(cfg.ref, 'ref', 80, false) };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-propose-org-removal');
        const reads = need(ctx.reads, 'lyam-propose-org-removal');
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (!(chk.state === 'decided' && t?.decision)) {
                if (t?.status === 'canceled') bad('lyam-propose-org-removal: the task was canceled');
                throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'org-removal' });
            }
            if (t.decision !== 'approved') return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, removed: false };
            if (ctx.test || ctx.dryRun) return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false };
            // APPLY-TIME control: re-read the references on the SAME ref the approval covered, never the stale snapshot.
            const approved = t.detail?.impact ?? null;
            const ref = str(t.detail?.ref, 'ref', 80, false) || ctx.baseBranch || 'main';
            const now = await reads.listOrganizations(ctx.tenant, ref);
            const org = now.orgs.find((o) => o.id === c.id);
            if (!org) { ctx.log(`organization "${c.id}" is already absent on ${ref}: nothing to remove`); return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false, alreadyAbsent: true }; }
            const impact = orgImpactOf(now.orgs, now.members, c.id);
            if (impact.childCount > 0) bad(`lyam-propose-org-removal: "${c.id}" still has ${impact.childCount} child organization(s) (${impact.children.join(', ')}): re-parent or remove them first`);
            if (!sameImpact(approved, impact)) bad(`lyam-propose-org-removal: the references of "${c.id}" changed since the approval (${approved ? `${approved.memberCount} member(s)` : 'no recorded impact'} -> ${impact.memberCount} member(s), ${approved ? approved.childCount : '?'} -> ${impact.childCount} child organization(s)): propose the removal again with the current impact`);
            let removed = false;
            await ctx.branchWrite(async (db) => {
                for (const ddl of ORG_TABLES_DDL) await db.query(ddl);
                await db.query('delete from org_memberships where tenant = ? and org_id = ?', [ctx.tenant, c.id]);
                const [r] = await db.query('delete from organizations where tenant = ? and id = ?', [ctx.tenant, c.id]);
                removed = Number(r?.affectedRows ?? 0) > 0;
            }, `workflow: remove organization ${c.id} (approved task ${t.id})`);
            ctx.log(`organization "${c.id}" removed on the run branch after approval by ${t.decided_by} (references re-checked at apply time)`);
            return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed, impact };
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would propose the removal of organization "${c.id}" to ${c.assignee}`); return { taskId: 'test', decision: 'approved', decidedBy: c.assignee, removed: false }; }
        const ref = readRef(ctx, ctx.config);
        const r = await reads.listOrganizations(ctx.tenant, ref);
        const org = r.orgs.find((o) => o.id === c.id);
        if (!org) bad(`lyam-propose-org-removal: unknown organization "${c.id}" on ${ref}`);
        const impact = orgImpactOf(r.orgs, r.members, c.id);
        if (impact.childCount > 0) bad(`lyam-propose-org-removal: "${c.id}" has ${impact.childCount} child organization(s) (${impact.children.join(', ')}): re-parent or remove them first`);
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'org-removal', title: `Remove organization "${c.id}"`, detail: { org: c.id, reason: c.reason, ref, impact, decisions: ['approved', 'refused'] }, assignee: c.assignee, preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        ctx.log(`removal of organization "${c.id}" proposed to ${c.assignee} (impact: ${impact.memberCount} member(s), 0 child organization(s))`);
        throw new WorkflowSuspend({ taskId: t.id, kind: 'org-removal' });
    },
};

// ---- P1 #7: applications and SSO access, lifecycle and authorized roles -------------------------------------

/** The app_connectors row as the module's config object (the shape its own build() validator expects). */
const appRowToConfig = (row) => ({ id: row.id, name: row.name, description: row.description ?? '', protocol: row.protocol ?? 'oidc', enabled: !!row.enabled, ...(typeof row.config === 'string' ? JSON.parse(row.config || '{}') : (row.config ?? {})) });

const appLifecycleBlock = (type, label, patchOf, verb) => writeBlock(type, label, `REAL write ON THE RUN BRANCH: ${verb}. The change goes through the app-connector module's own validators (redirect URIs, SP certificate, attribute mapping, allowed roles, secret_ref by reference only): never a free uncontrolled field. Reviewed and published like every other data change.`, [
    { key: 'id', label: 'Application id', type: 'string', required: true },
    { key: 'value', label: 'Value', type: 'string', required: true },
], (cfg) => ({ id: idf(cfg.id, `${type}.id`), value: patchOf(cfg) }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would ${verb} for application "${c.id}" on the run branch`); return { id: c.id, changed: false }; }
    let changed = false;
    await ctx.branchWrite(async (db) => {
        await db.query(APP_CONNECTOR_DDL); // the app-connector plugin owns this schema: never a divergent copy
        const [rows] = await db.query('select * from app_connectors where tenant = ? and id = ?', [ctx.tenant, c.id]);
        const row = (rows ?? [])[0];
        if (!row) bad(`${type}: unknown application "${c.id}" on the run branch`);
        const cur = appRowToConfig(row);
        const validated = buildAppConfig(c.id, c.value, cur); // the module's own validators, never a free field
        await db.query('update app_connectors set enabled = ?, config = ? where tenant = ? and id = ?', [validated.enabled ? 1 : 0, appConnectorConfig(validated), ctx.tenant, c.id]);
        changed = true;
    }, `workflow: ${type} ${c.id}`);
    ctx.log(`application "${c.id}" updated on the run branch (${verb})`);
    return { id: c.id, changed };
});

const patchEnabled = (cfg) => { const v = str(cfg.value, 'value', 8); if (v !== 'yes' && v !== 'no') bad('value: yes or no'); return { enabled: v === 'yes' }; };
const lyamSetApplicationEnabled = appLifecycleBlock('lyam-set-application-enabled', 'Enable or disable an application', patchEnabled, 'enable or disable it');
const lyamSetApplicationRoles = appLifecycleBlock('lyam-set-application-roles', 'Set the authorized roles of an application', (cfg) => ({ allowed_roles: str(cfg.value, 'value', 2000).split(',').map((x) => x.trim()).filter(Boolean) }), 'set its authorized roles');

const lyamProposeApplicationRemoval = {
    type: 'lyam-propose-application-removal', family: 'lyam', label: 'Propose an application removal', simulated: false, category: 'real',
    description: 'Opens an approval task SHOWING what the application removal loses (protocol, authorized roles), SUSPENDS the run until the decision, and only after approval removes the application connector ON THE RUN BRANCH (versioned: reviewed and published like every other change). The state is re-read at apply time: an application that was re-enabled or reconfigured since the approval is refused, and an enabled application is never removed (disable it first, the module rule).',
    fields: [
        { key: 'id', label: 'Application id', type: 'string', required: true },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
        { key: 'assignee', label: 'Decider', type: 'string', default: 'admin' },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'removed', description: 'Whether the application was removed on the run branch' }],
    validate(cfg) {
        return { id: idf(cfg.id, 'lyam-propose-application-removal.id'), reason: str(cfg.reason, 'lyam-propose-application-removal.reason', 500), assignee: str(cfg.assignee, 'lyam-propose-application-removal.assignee', 64, false) || 'admin', ref: str(cfg.ref, 'ref', 80, false) };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-propose-application-removal');
        const reads = need(ctx.reads, 'lyam-propose-application-removal');
        const stateOf = async (ref) => {
            const r = await reads.listApplications(ctx.tenant, ref);
            const a = r.applications.find((x) => x.id === c.id);
            return a ? { enabled: a.enabled, name: a.name, protocol: a.protocol, allowedRoles: [...a.allowedRoles].sort() } : null;
        };
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (!(chk.state === 'decided' && t?.decision)) {
                if (t?.status === 'canceled') bad('lyam-propose-application-removal: the task was canceled');
                throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'application-removal' });
            }
            if (t.decision !== 'approved') return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, removed: false };
            if (ctx.test || ctx.dryRun) return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false };
            // APPLY-TIME control: re-read the state on the SAME ref the approval covered.
            const approved = t.detail?.impact ?? null;
            const ref = str(t.detail?.ref, 'ref', 80, false) || ctx.baseBranch || 'main';
            const now = await stateOf(ref);
            if (!now) { ctx.log(`application "${c.id}" is already absent on ${ref}: nothing to remove`); return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false, alreadyAbsent: true }; }
            if (now.enabled) bad(`lyam-propose-application-removal: "${c.id}" is enabled: disable it first (the app-connector module rule), then propose the removal again`);
            if (!approved || approved.enabled !== now.enabled || approved.name !== now.name || approved.protocol !== now.protocol || JSON.stringify(approved.allowedRoles) !== JSON.stringify(now.allowedRoles))
                bad(`lyam-propose-application-removal: the state of "${c.id}" changed since the approval: propose the removal again with the current state`);
            let removed = false;
            await ctx.branchWrite(async (db) => {
                await db.query(APP_CONNECTOR_DDL);
                const [r] = await db.query('delete from app_connectors where tenant = ? and id = ? and enabled = 0', [ctx.tenant, c.id]);
                removed = Number(r?.affectedRows ?? 0) > 0;
            }, `workflow: remove application ${c.id} (approved task ${t.id})`);
            ctx.log(`application "${c.id}" removed on the run branch after approval by ${t.decided_by} (state re-checked at apply time)`);
            return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed };
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would propose the removal of application "${c.id}" to ${c.assignee}`); return { taskId: 'test', decision: 'approved', decidedBy: c.assignee, removed: false }; }
        const ref = readRef(ctx, ctx.config);
        const now = await stateOf(ref);
        if (!now) bad(`lyam-propose-application-removal: unknown application "${c.id}" on ${ref}`);
        if (now.enabled) bad(`lyam-propose-application-removal: "${c.id}" is enabled: disable it first (lyam-set-application-enabled), then propose the removal`);
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'application-removal', title: `Remove application "${c.id}"`, detail: { application: c.id, reason: c.reason, ref, impact: now, decisions: ['approved', 'refused'] }, assignee: c.assignee, preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        ctx.log(`removal of application "${c.id}" proposed to ${c.assignee}`);
        throw new WorkflowSuspend({ taskId: t.id, kind: 'application-removal' });
    },
};

/** Keys whose VALUE must never transit a workflow definition or a task detail: secrets stay in the
 *  server-side secret store and are referenced by name. */
const SECRET_KEY_RE = /secret|password|token|private.?key|credential/i;
/** True when an object carries a non-empty secret-looking value. */
const hasSecretValue = (o) => {
    if (Array.isArray(o)) return o.some(hasSecretValue);
    if (o && typeof o === 'object') return Object.entries(o).some(([k, v]) => SECRET_KEY_RE.test(k) ? (v !== null && v !== undefined && v !== '') : hasSecretValue(v));
    return false;
};

// ---- P1 #11: validated CSV and SCIM-like imports ------------------------------------------------------------

// The SoD check, textually identical to the core import flow (apps/api/src/dolt/dolt.service.ts SOD_SQL).
const IMPORT_SOD_SQL = 'select a.identity_id as identity, r.role_a as roleA, r.role_b as roleB from assignments a join assignments b on a.identity_id = b.identity_id join sod_rules r on r.role_a = a.role_id and r.role_b = b.role_id';

/** The staging the core import flow applies (apps/api/src/dolt/changes.controller.ts stageImport), on the run branch. */
const importBlock = (type, label, source, parse) => writeBlock(type, label, `REAL write ON THE RUN BRANCH: validates a ${source} import (strict parsing, known roles, 1 to 500 rows, sensitive roles refused) and stages it on the run branch, then runs the Separation-of-Duties simulation. Nothing lands on main without the human publication review; a mergeable:false result lists the violations to fix first, and the identities the import overwrites are listed. Note: the payload lives in the workflow definition (readable by definition readers): import the smallest useful extract.`, [
    { key: 'payload', label: `${source} payload`, type: 'text', required: true },
], (cfg) => {
    const payload = str(cfg.payload, `${type}.payload`, 200000);
    parse(payload); // validation errors surface at definition time, with the exact line
    return { payload };
}, async (ctx) => {
    const c = ctx.config;
    const { rows, skipped } = parse(c.payload);
    if (!rows.length || rows.length > 500) bad(`${type}: 1 to 500 rows expected (${rows.length} given)`);
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would import ${rows.length} row(s) on the run branch`); return { rows: rows.length, staged: false }; }
    let violations = [];
    let overwrites = [];
    await ctx.branchWrite(async (db) => {
        const [rr] = await db.query('select id, is_sensitive from roles');
        const roles = new Set((rr ?? []).map((x) => x.id));
        const unknown = rows.filter((x) => !roles.has(x.role));
        if (unknown.length) bad(`${type}: unknown role(s) in the import: ${[...new Set(unknown.map((x) => x.role))].join(', ')}`);
        // A sensitive role is never granted by a bulk import: it goes through its dedicated guarded path.
        const sensitive = new Set((rr ?? []).filter((x) => x.is_sensitive).map((x) => x.id));
        const hit = rows.filter((x) => sensitive.has(x.role));
        if (hit.length) bad(`${type}: sensitive role(s) refused in a bulk import: ${[...new Set(hit.map((x) => x.role))].join(', ')} (grant them with the dedicated guarded blocks)`);
        const ids = rows.map((x) => x.identity);
        const [ex] = await db.query(`select id from identities where id in (${ids.map(() => '?').join(',')})`, ids);
        overwrites = (ex ?? []).map((x) => x.id);
        for (const r of rows) {
            await db.query('insert into identities (id,display_name,manager_id,department) values (?,?,?,?) on duplicate key update display_name=values(display_name),manager_id=values(manager_id),department=values(department)', [r.identity, r.displayName, r.manager, r.department]);
            await db.query('insert ignore into assignments values (?,?)', [r.identity, r.role]);
        }
        const [v] = await db.query(IMPORT_SOD_SQL);
        violations = (v ?? []).map((x) => ({ identity: x.identity, roleA: x.roleA, roleB: x.roleB }));
    }, `workflow: ${source} import ${rows.length} rows`);
    ctx.log(`${rows.length} row(s) staged on the run branch, ${violations.length} SoD violation(s), ${overwrites.length} existing identit(y/ies) overwritten (visible in the publication diff)`);
    return { rows: rows.length, ...(skipped !== undefined ? { skipped } : {}), overwrites, violations, mergeable: violations.length === 0, staged: true };
});

const lyamImportCsv = importBlock('lyam-import-csv', 'Import a CSV file (validated)', 'CSV', (payload) => ({ rows: csvToRows(payload) }));
const lyamImportScim = importBlock('lyam-import-scim', 'Import a SCIM-like payload (validated)', 'SCIM-like', (payload) => { let body; try { body = JSON.parse(payload); } catch { bad('lyam-import-scim.payload: not valid JSON'); } return scimToRows(body); });

// ---- P2 #10: mail templates and theme ------------------------------------------------------------------------

// The Dolt mail-template store schema (apps/api/src/mail/mail-templates.ts): the service owns it, never a divergent copy.
const MAIL_TPL_DDL = "create table if not exists plg_mail_templates_custom (tenant varchar(32) not null, tpl_key varchar(64) not null, lang varchar(8) not null default 'en', subject text null, body_text mediumtext null, body_html mediumtext null, extra json null, updated_at varchar(32) not null, primary key (tenant, tpl_key, lang))";

const lyamReadMailTemplates = readBlock('lyam-read-mail-templates', 'List the mail templates', 'Lists the declared mail templates with their customization state on a ref (keys, names, variables: never the stored bodies).', [
    { key: 'ref', label: 'Ref (branch, default: the run base)', type: 'string' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-read-mail-templates').listMailTemplates(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.templates.length} mail template(s), ${r.templates.filter((t) => t.customized).length} customized`);
    return r;
});

const lyamPreviewMailTemplate = readBlock('lyam-preview-mail-template', 'Preview a mail template', 'Renders a mail template WITHOUT saving anything (the editor live preview), with optional sample data and an unsaved override. A preview never sends a mail.', [
    { key: 'key', label: 'Template key', type: 'string', required: true },
    { key: 'data', label: 'Sample data (JSON, optional)', type: 'text' },
    { key: 'override', label: 'Unsaved override (JSON, optional)', type: 'text' },
    { key: 'ref', label: 'Ref (branch, default: the run base)', type: 'string' },
], async (ctx) => {
    const key = str(ctx.config.key, 'lyam-preview-mail-template.key', 64);
    const data0 = jsonObj(ctx.config.data, 'lyam-preview-mail-template.data');
    const override0 = jsonObj(ctx.config.override, 'lyam-preview-mail-template.override');
    const data = Object.keys(data0).length ? data0 : undefined;
    const override = Object.keys(override0).length ? override0 : undefined;
    const r = await need(ctx.reads, 'lyam-preview-mail-template').previewMailTemplate(ctx.tenant, readRef(ctx, ctx.config), key, data, override);
    ctx.log(`template "${key}" rendered for preview (nothing saved, nothing sent)`);
    return r;
});

const lyamProposeMailTemplate = writeBlock('lyam-propose-mail-template', 'Propose a mail template override', 'REAL write ON THE RUN BRANCH: stores a mail template override (subject and/or bodies), validated and rendered first. Versioned: reviewed and published like every other data change. The block NEVER sends a mail.', [
    { key: 'key', label: 'Template key', type: 'string', required: true },
    { key: 'subject', label: 'Subject (optional)', type: 'string' },
    { key: 'text', label: 'Text body (optional)', type: 'text' },
    { key: 'html', label: 'HTML body (optional)', type: 'text' },
], (cfg) => {
    const key = str(cfg.key, 'lyam-propose-mail-template.key', 64);
    const subject = str(cfg.subject, 'subject', 200, false), text = str(cfg.text, 'text', 20000, false), html = str(cfg.html, 'html', 50000, false);
    if (!subject && !text && !html) bad('lyam-propose-mail-template: at least one of subject, text or html');
    // Backstop, not a sanitizer: an override reaches every future mail, so active content is refused outright.
    if (html && /<\s*(script|iframe|form)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(html)) bad('lyam-propose-mail-template.html: active content (script, iframe, form, event handler, javascript:) is refused');
    return { key, subject, text, html };
}, async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log(`test run: would store an override of template "${c.key}" on the run branch`); return { key: c.key, saved: false }; }
    // Render the candidate first: a template that does not render is refused before any write.
    await need(ctx.reads, 'lyam-propose-mail-template').previewMailTemplate(ctx.tenant, ctx.runBranch ?? ctx.baseBranch ?? 'main', c.key, undefined, { subject: c.subject || undefined, text: c.text || undefined, ...(c.html ? { html: c.html } : {}) });
    await ctx.branchWrite(async (db) => {
        await db.query(MAIL_TPL_DDL);
        await db.query('insert into plg_mail_templates_custom (tenant, tpl_key, lang, subject, body_text, body_html, extra, updated_at) values (?,?,?,?,?,?,?,?) on duplicate key update subject=values(subject), body_text=values(body_text), body_html=values(body_html), updated_at=values(updated_at)', [ctx.tenant, c.key, 'en', c.subject || null, c.text || null, c.html || null, null, new Date().toISOString()]);
    }, `workflow: mail template override ${c.key}`);
    ctx.log(`override of template "${c.key}" written on the run branch (rendered first; nothing sent)`);
    return { key: c.key, saved: true };
});

const lyamPreviewTheme = readBlock('lyam-preview-theme', 'Validate and preview a theme', 'Validates a theme candidate against the branding module (colors, contrast, SVG sanitization) on a ref and returns a summary. Validates only: nothing is stored.', [
    { key: 'theme', label: 'Theme candidate (JSON)', type: 'text', required: true },
    { key: 'ref', label: 'Ref (branch, default: the run base)', type: 'string' },
], async (ctx) => {
    const input = jsonObj(ctx.config.theme, 'lyam-preview-theme.theme');
    const r = await need(ctx.reads, 'lyam-preview-theme').validateTheme(ctx.tenant, readRef(ctx, ctx.config), input);
    if (!r.valid) bad(`lyam-preview-theme: invalid theme (${(r.errors ?? []).join('; ')})`);
    ctx.log(`theme candidate valid (provider ${r.provider})`);
    return { valid: true, provider: r.provider, summary: r.summary, version: r.version };
});

const lyamProposeTheme = writeBlock('lyam-propose-theme', 'Propose a theme', 'REAL write ON THE RUN BRANCH: merges a theme candidate into the current branding settings, validates the RESULT against the branding module (contrast, SVG sanitization) and stores it. Versioned: reviewed and published like every other data change.', [
    { key: 'theme', label: 'Theme patch (JSON)', type: 'text', required: true },
], (cfg) => ({ theme: jsonObj(cfg.theme, 'lyam-propose-theme.theme') }), async (ctx) => {
    const c = ctx.config;
    if (ctx.test || ctx.dryRun) { ctx.log('test run: would store a theme candidate on the run branch'); return { saved: false }; }
    const reads = need(ctx.reads, 'lyam-propose-theme');
    const ref = ctx.runBranch ?? ctx.baseBranch ?? 'main';
    const current = await reads.themeSettings(ctx.tenant, ref);
    const merged = { ...current.settings, ...c.theme };
    const v = await reads.validateTheme(ctx.tenant, ref, merged);
    if (!v.valid) bad(`lyam-propose-theme: the merged theme is invalid (${(v.errors ?? []).join('; ')})`);
    await ctx.branchWrite(async (db) => {
        await db.query('create table if not exists plugin_runtime_settings (tenant varchar(32), plugin varchar(64), settings json not null, primary key(tenant,plugin))');
        await db.query('insert into plugin_runtime_settings (tenant, plugin, settings) values (?,?,?) on duplicate key update settings = values(settings)', [ctx.tenant, v.provider, JSON.stringify(v.values)]);
    }, 'workflow: theme proposal (validated)');
    ctx.log(`theme written on the run branch (provider ${v.provider}, validated merged result)`);
    return { saved: true, provider: v.provider, summary: v.summary };
});

// ---- P1 #8: authentication reads, policy proposals, re-enrollment and reset requests ---------------------------

const lyamReadAuthn = readBlock('lyam-read-authn', 'Read the authentication configuration', 'Reads the STRUCTURE of the authentication configuration on a ref: methods and chains with their levels, never a setting value (even masked secrets stay server-side).', [
    { key: 'ref', label: 'Ref (branch, default: the run base)', type: 'string' },
], async (ctx) => {
    const r = await need(ctx.reads, 'lyam-read-authn').authnConfig(ctx.tenant, readRef(ctx, ctx.config));
    ctx.log(`${r.methods.length} method(s), ${r.chains.length} chain(s)`);
    return r;
});

const lyamReadEnrollments = readBlock('lyam-read-enrollments', 'Read the enrollments of a user', 'Reads the LIVE enrollment status of a user: which factors are set up on which method instance. Live operational state, unversioned; never a secret.', [
    { key: 'user', label: 'User id', type: 'string', required: true },
], async (ctx) => {
    const user = userId(ctx.config.user, 'lyam-read-enrollments.user');
    const st = await need(ctx.authn, 'lyam-read-enrollments').enrollments(ctx.tenant, user);
    const instances = Object.entries(st ?? {}).map(([instance, s]) => {
        const kinds = ['totp', 'pin', 'email', 'external', 'webauthn'].filter((k) => !!s[k]);
        return { instance, kinds, enrolled: kinds.length > 0 };
    });
    ctx.log(`${instances.filter((i) => i.enrolled).length} enrolled instance(s) for "${user}"`);
    return { user, instances };
});

/** A deep redaction for a candidate authn configuration shown in a task: secret-looking values never reach the task detail. */
const redactSecrets = (o) => {
    if (Array.isArray(o)) return o.map(redactSecrets);
    if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEY_RE.test(k) && v !== null && v !== undefined && v !== '' ? '<server-side>' : redactSecrets(v)]));
    return o;
};

const lyamProposeAuthnPolicy = {
    type: 'lyam-propose-authn-policy', family: 'lyam', label: 'Propose an authentication policy change', simulated: false, category: 'real',
    description: 'Opens a REINFORCED approval task (whole admin pool, anti-self-approval) for an authentication policy change, SUSPENDS the run until the decision, and only after approval writes the validated configuration ON THE RUN BRANCH (versioned: reviewed and published like every other change). The candidate is validated before the task opens and again by the configuration service at write time, and the applied object is bound to the approved one by a hash recorded in the task. Values under secret-LOOKING keys are refused: that is a key-name heuristic, not a guarantee that no secret can pass under an innocuous key — the control is the admin pool reviewing the exact approved object. Secrets belong in the server-side store, referenced by name.',
    fields: [
        { key: 'config', label: 'Configuration (JSON)', type: 'text', required: true },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'applied', description: 'Whether the configuration was written on the run branch' }],
    validate(cfg) {
        return { config: str(cfg.config, 'lyam-propose-authn-policy.config', 20000), reason: str(cfg.reason, 'lyam-propose-authn-policy.reason', 500) };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-propose-authn-policy');
        const authn = need(ctx.authn, 'lyam-propose-authn-policy');
        // No workflow placeholders: the approved object must be exactly the applied object.
        if (/\{\{|\}\}/.test(c.config)) bad('lyam-propose-authn-policy.config: no workflow placeholders: the policy is applied exactly as approved');
        let input; try { input = JSON.parse(c.config); } catch { bad('lyam-propose-authn-policy.config: not valid JSON'); }
        // A secret value is never persisted in a definition or a task: it stays in the server-side store, referenced by name.
        if (hasSecretValue(input)) bad('lyam-propose-authn-policy.config: a secret-looking value was given inline: secrets stay in the server-side store, give a reference, never a value');
        const configHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (!(chk.state === 'decided' && t?.decision)) {
                if (t?.status === 'canceled') bad('lyam-propose-authn-policy: the task was canceled');
                throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'authn-policy-change' });
            }
            if (t.decision !== 'approved') return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, applied: false };
            if (ctx.test || ctx.dryRun) return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, applied: false };
            // Bind the applied object to the approved one: the hash recorded in the task must match the candidate.
            if (t.detail?.configHash !== configHash) bad('lyam-propose-authn-policy: the candidate configuration no longer matches the approved one: propose the change again');
            const branch = ctx.runBranch;
            if (!branch) bad('lyam-propose-authn-policy: this run has no data branch');
            await authn.savePolicy(ctx.tenant, { branch, input }); // validates again inside the configuration service
            ctx.log(`authentication policy written on the run branch after approval by ${t.decided_by}`);
            return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, applied: true };
        }
        if (ctx.test || ctx.dryRun) { ctx.log('test run: would propose an authentication policy change to the admin pool'); return { taskId: 'test', decision: 'approved', decidedBy: 'admin', applied: false }; }
        const v = authn.validatePolicy(input);
        if (!v.valid) bad(`lyam-propose-authn-policy: invalid configuration (${(v.errors ?? []).join('; ')})`);
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'authn-policy-change', title: 'Change the authentication policy', detail: { reason: c.reason, config: redactSecrets(input), configHash, decisions: ['approved', 'refused'] }, assignee: 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        ctx.log('authentication policy change proposed to the admin pool (reinforced)');
        throw new WorkflowSuspend({ taskId: t.id, kind: 'authn-policy-change' });
    },
};

const lyamRequestReenrollment = {
    type: 'lyam-request-reenrollment', family: 'lyam', label: 'Request a re-enrollment', simulated: false, category: 'real',
    description: 'After a human approval, asks for a factor to be enrolled again: removes the current enrollment and notifies the user, who re-enrolls themself in self-service. The block NEVER enrolls a factor in the holder\'s place. IMMEDIATE, UNVERSIONED effects: the removal and the notification apply at once and are NOT reverted by a later merge or publication; a durable intent is recorded right before them, so a crash leaves the step in review (EXTERNAL_EFFECT_REVIEW_REQUIRED) rather than retrying blindly. The notification goes to the demonstration outbox (real=false): no real e-mail is sent. Session revocation is deliberately absent: the brief makes it conditional on a safe business service, which does not exist yet. Scope of the lockout guard: \'enrolled\' means a recorded enrollment of one of the five factor kinds — a recorded-but-unusable factor is not distinguished, and removals made through THIS workflow are serialized per user inside one API process only: a self-unenrollment by the user or a console removal does not pass through that lock, so there is no global protection against every concurrent removal.',
    fields: [
        { key: 'user', label: 'User id', type: 'string', required: true },
        { key: 'instance', label: 'Method instance id', type: 'string', required: true },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'removed', description: 'Whether the enrollment was removed (immediate)' }, { key: 'notified', description: 'Whether the notification was recorded (demo outbox)' }],
    validate(cfg) {
        // The decider is ALWAYS the whole admin pool: the effect is immediate and never reverted, so the
        // workflow author never routes it to a chosen person.
        return { user: userId(cfg.user, 'lyam-request-reenrollment.user'), instance: idf(cfg.instance, 'lyam-request-reenrollment.instance'), reason: str(cfg.reason, 'lyam-request-reenrollment.reason', 500), assignee: 'admin' };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-request-reenrollment');
        const authn = need(ctx.authn, 'lyam-request-reenrollment');
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (!(chk.state === 'decided' && t?.decision)) {
                if (t?.status === 'canceled') bad('lyam-request-reenrollment: the task was canceled');
                throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'reenrollment-request' });
            }
            if (t.decision !== 'approved') return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, removed: false, notified: false };
            if (ctx.test || ctx.dryRun) return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false, notified: false };
            if (!ctx.markEffectPending) bad('lyam-request-reenrollment: the durable intent mechanism is not available on this server');
            // The guards are re-evaluated at APPLY time: the target may have become an administrator or
            // lost their other factors since the approval.
            if (need(authn.targetIsAdmin, 'lyam-request-reenrollment')(c.user)) bad(`lyam-request-reenrollment: "${c.user}" is an administrator: an immediate re-enrollment of an administrator is refused`);
            const live = await authn.enrollments(ctx.tenant, c.user);
            const others = Object.entries(live ?? {}).filter(([i, st2]) => i !== c.instance && ['totp', 'pin', 'email', 'external', 'webauthn'].some((k) => !!st2[k]));
            if (!others.length && (live ?? {})[c.instance] && ['totp', 'pin', 'email', 'external', 'webauthn'].some((k) => !!(live ?? {})[c.instance]?.[k])) bad(`lyam-request-reenrollment: "${c.instance}" is the last enrolled factor of "${c.user}": removing it would lock the user out (they must sign in to re-enroll)`);
            // The state at APPLY time, never the state at proposal time: the factor may already be gone.
            await ctx.markEffectPending({ action: 'reenrollment-request', user: c.user, instance: c.instance });
            const r = await authn.unenroll(ctx.tenant, { runId: ctx.runId, user: c.user, instance: c.instance, reason: c.reason });
            if (!r.removed) { ctx.log(`"${c.instance}" was already absent for "${c.user}" at apply time: nothing removed, no notification sent`); return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: false, alreadyAbsent: true, notified: false }; }
            await authn.notify(ctx.tenant, { to: c.user, subject: 'A sign-in method must be set up again', text: `An administrator asked for the "${c.instance}" sign-in method to be set up again. Reason: ${c.reason}. Sign in and enroll it again from your own security page.`, subjectUser: c.user });
            ctx.log(`re-enrollment requested for "${c.user}" (${c.instance}): enrollment removed (immediate, unversioned) and notification recorded in the demo outbox, approved by ${t.decided_by}`);
            return { taskId: t.id, decision: 'approved', decidedBy: t.decided_by, removed: true, notified: true };
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would request the re-enrollment of "${c.instance}" for "${c.user}"`); return { taskId: 'test', decision: 'approved', decidedBy: c.assignee, removed: false, notified: false }; }
        // Proposal-time guards: never an administrator (an immediate, non-reverted effect on an admin
        // account is refused), never the last enrolled factor (the user must sign in to re-enroll:
        // removing the only factor would lock them out).
        if (need(authn.targetIsAdmin, 'lyam-request-reenrollment')(c.user)) bad(`lyam-request-reenrollment: "${c.user}" is an administrator: an immediate re-enrollment of an administrator is refused`);
        const st = await authn.enrollments(ctx.tenant, c.user);
        const cur = (st ?? {})[c.instance];
        const kinds = cur ? ['totp', 'pin', 'email', 'external', 'webauthn'].filter((k) => !!cur[k]) : [];
        if (!kinds.length) bad(`lyam-request-reenrollment: "${c.user}" has no enrollment on "${c.instance}" (nothing to request)`);
        const others = Object.entries(st ?? {}).filter(([i, s2]) => i !== c.instance && ['totp', 'pin', 'email', 'external', 'webauthn'].some((k) => !!s2[k]));
        if (!others.length) bad(`lyam-request-reenrollment: "${c.instance}" is the last enrolled factor of "${c.user}": removing it would lock the user out`);
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'reenrollment-request', title: `Re-enrollment of "${c.instance}" for "${c.user}"`, detail: { user: c.user, subject: c.user, instance: c.instance, reason: c.reason, currentEnrollments: kinds, decisions: ['approved', 'refused'] }, assignee: c.assignee, preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        ctx.log(`re-enrollment of "${c.instance}" for "${c.user}" proposed to ${c.assignee} (currently: ${kinds.join(', ')})`);
        throw new WorkflowSuspend({ taskId: t.id, kind: 'reenrollment-request' });
    },
};

const lyamProposePasswordReset = {
    type: 'lyam-propose-password-reset', family: 'lyam', label: 'Propose a password reset', simulated: false, category: 'real',
    description: 'Opens an approval task for a password reset (whole admin pool, anti-self-approval; the beneficiary is barred from deciding by the anti-self rule, which covers detail.subject). The block never touches the credential itself: after approval, the following steps do it: lyam-generate-password, then lyam-apply-password-reset (bound to this approval, this account and this validity, admin status re-checked at the effect), then publication, then lyam-send-secret-mail given the same approval task (re-checked before the mail). Do not use the generic lyam-set-temporary-password in a reset path: it knows no approval. Guards at proposal time: the target must EXIST, and an administrator target is refused (an admin credential reset is a console operation between two administrators, never a workflow effect). What is VERSIONED: the temporary credential, on the run branch until publication. What is IMMEDIATE once published: the forced first-access change (the user chooses their own password at the next sign-in), not reverted by a later publication. The secret mail stays guarded by its real-state check and goes to the demonstration outbox: no real e-mail.',
    fields: [
        { key: 'subject', label: 'User id', type: 'string', required: true },
        { key: 'hours', label: 'Temporary validity (hours)', type: 'string', default: '24' },
        { key: 'reason', label: 'Reason', type: 'text', required: true },
    ],
    outputs: [{ key: 'taskId', description: 'The durable task id' }, { key: 'decision', description: 'approved or refused' }, { key: 'decidedBy', description: 'Who decided' }, { key: 'subject', description: 'The account of the proposal (the approval is bound to it)' }, { key: 'hours', description: 'The approved validity in hours' }],
    validate(cfg) {
        const hours = str(cfg.hours, 'hours', 8, false) || '24';
        if (!/^\d{1,4}(\.\d{1,2})?$/.test(hours) || !(Number(hours) > 0 && Number(hours) <= 720)) bad('hours: more than 0 and at most 720');
        // The decider is ALWAYS the whole admin pool: a credential operation is never routed to a chosen person by the workflow author.
        return { subject: userId(cfg.subject, 'subject'), hours, reason: str(cfg.reason, 'reason', 500), title: `Password reset for ${userId(cfg.subject, 'subject')}`, detail: { subject: userId(cfg.subject, 'subject'), hours, reason: str(cfg.reason, 'reason', 500) }, assignee: 'admin' };
    },
    async run(ctx) {
        const c = ctx.config;
        const tasks = need(ctx.tasks, 'lyam-propose-password-reset');
        if (ctx.resumeWait?.taskId) {
            const chk = await tasks.check(ctx.tenant, ctx.resumeWait.taskId);
            const t = chk.task;
            if (chk.state === 'decided' && t?.decision) {
                // Re-checked when the approval is consumed (the following steps do the credential work): a target
                // promoted to administrator since the proposal is refused, so the approval cannot be used for it.
                if (t.decision === 'approved' && !(ctx.test || ctx.dryRun) && need(ctx.authn, 'lyam-propose-password-reset').targetIsAdmin(c.subject)) bad(`lyam-propose-password-reset: "${c.subject}" became an administrator since the proposal: the approval is refused, propose again through the console`);
                return { taskId: t.id, decision: t.decision, decidedBy: t.decided_by, justification: t.justification ?? '', subject: c.subject, hours: c.hours };
            }
            if (t?.status === 'canceled') bad('lyam-propose-password-reset: the task was canceled');
            throw new WorkflowSuspend({ taskId: ctx.resumeWait.taskId, kind: 'lyam-propose-password-reset' });
        }
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would open the proposal task "${c.title}"`); return { taskId: 'test', decision: 'approved', decidedBy: 'admin', justification: '' }; }
        // Proposal-time guards: the target must exist on the run base, and an administrator target is refused.
        if (need(ctx.authn, 'lyam-propose-password-reset').targetIsAdmin(c.subject)) bad(`lyam-propose-password-reset: "${c.subject}" is an administrator: an admin credential reset is a console operation between two administrators, never a workflow effect`);
        await need(ctx.reads, 'lyam-propose-password-reset').readUser(ctx.tenant, ctx.baseBranch || 'main', c.subject); // throws on an unknown identity
        const t = await tasks.request({ tenant: ctx.tenant, kind: 'lyam-propose-password-reset', title: c.title, detail: { ...c.detail, decisions: ['approved', 'refused'] }, assignee: 'admin', preventSelfApproval: true, runId: ctx.runId, nodeId: ctx.nodeId });
        throw new WorkflowSuspend({ taskId: t.id, kind: 'lyam-propose-password-reset' });
    },
};


/**
 * Authority check for a password reset, run AT THE EFFECT (never only at proposal): the approval task must be decided "approved", be the reset
 * proposal of THIS run, and be bound to exactly this target and this validity; and the target must not be an administrator right now.
 * Used by lyam-apply-password-reset (before the credential is written) and by lyam-send-secret-mail when it carries the approval (before the mail leaves).
 */
export async function assertResetApproval(ctx, who, taskId, subject, hours, phase = 'later', revision = '') {
    const tasks = need(ctx.tasks, who), authn = need(ctx.authn, who);
    const id = str(taskId, `${who}.approvalTaskId`, 80);
    const chk = await tasks.check(ctx.tenant, id);
    const t = chk?.task;
    if (!t || chk.state !== 'decided' || t.status !== 'decided' || t.decision !== 'approved') bad(`${who}: the approval task is not an approved decision`);
    if (t.kind !== 'lyam-propose-password-reset') bad(`${who}: the task is not a password reset proposal`);
    if (t.run_id !== ctx.runId) bad(`${who}: the approval was given to another run: it cannot be used here`);
    if (String(t.detail?.subject) !== String(subject)) bad(`${who}: the approval covers another account than "${subject}"`);
    if (String(t.detail?.hours) !== String(hours)) bad(`${who}: the approval covers another validity than ${hours} h`);
    if (!authn.adminsConfigured?.()) bad(`${who}: the administrator list is empty on this server, so the non-admin check would protect nothing: refused`);
    if (authn.targetIsAdmin(subject)) bad(`${who}: "${subject}" is an administrator now: the approval is refused, an admin credential reset is a console operation`);
    if (phase === 'apply') {
        // Single use, durable: the first apply consumes the approval; the same node resuming is idempotent; any other apply (another node, a loop pass of another run) is refused.
        if (typeof tasks.consume !== 'function') bad(`${who}: this server cannot mark an approval consumed`);
        await tasks.consume(ctx.tenant, id, `${ctx.runId}:${ctx.nodeId}`);
    } else {
        // Bound to the exact credential revision this run wrote: an approval that produced another effect, or none, is refused.
        if (!String(t.detail?.appliedBy ?? '').startsWith(`${ctx.runId}:`) || !revision || String(t.detail?.appliedRevision) !== String(revision)) bad(`${who}: the approval was not applied by this run with this credential revision`);
    }
}

const lyamApplyPasswordReset = {
    type: 'lyam-apply-password-reset', family: 'lyam', label: 'Apply an approved password reset', simulated: false, category: 'real',
    description: 'Records the generated password as the TEMPORARY credential of the account, on the run branch (versioned: not active until published and activated), ONLY IF the approval task of the reset proposal of this run is approved AND bound to this exact account and validity, AND the account is not an administrator at this moment. It replaces "Set the password as temporary" in a reset path: that generic block does not know any approval. The password never appears in the output. After this step: the first-access change is forced at the next sign-in (immediate once published, not reverted by a later publication). Residual window, stated: between this step and the publication the run branch holds the credential; the publication review shows it, and the secret mail (given the same approval task) re-checks approval binding and admin status right before it leaves.',
    fields: [
        { key: 'approvalTaskId', label: 'Approval task', type: 'string', required: true, help: '{{steps.<propose-reset>.taskId}}' },
        { key: 'subject', label: 'User id', type: 'string', required: true, help: 'must be the account of the approval' },
        { key: 'passwordRef', label: 'Password reference', type: 'string', required: true, help: 'from the generate step' },
        { key: 'hours', label: 'Validity (hours)', type: 'string', required: true, help: 'must equal the approved validity' },
    ],
    outputs: [{ key: 'subject', description: 'The user id' }, { key: 'revision', description: 'The credential revision written on the run branch' }, { key: 'expiresAt', description: 'Expiry (ms since epoch)' }, { key: 'hours', description: 'The validity' }],
    validate(cfg) {
        const hours = str(cfg.hours, 'hours', 8);
        if (!/\{\{/.test(hours) && (!/^\d{1,4}(\.\d{1,2})?$/.test(hours) || !(Number(hours) > 0 && Number(hours) <= 720))) bad('hours: more than 0 and at most 720');
        return { approvalTaskId: str(cfg.approvalTaskId, 'approvalTaskId', 80), subject: userId(cfg.subject, 'subject'), passwordRef: str(cfg.passwordRef, 'passwordRef', 80), hours };
    },
    async run(ctx) {
        const c = ctx.config;
        if (ctx.test || ctx.dryRun) { ctx.log(`test run: would apply an approved reset for "${c.subject}" - nothing written`); return { subject: c.subject, revision: null, expiresAt: null, hours: Number(c.hours) }; }
        if (!ctx.secrets || !ctx.setTemporaryPassword) bad('lyam-apply-password-reset: not available on this server');
        await assertResetApproval(ctx, 'lyam-apply-password-reset', c.approvalTaskId, c.subject, c.hours, 'apply');
        const password = ctx.secrets.reveal(c.passwordRef);
        const r = await ctx.setTemporaryPassword({ id: c.subject, password, hours: Number(c.hours) });
        if (!r?.revision || !(r.expiresAt > 0)) bad('lyam-apply-password-reset: the credential was not confirmed with its first-access rule');
        // The approval is burned once its effect is recorded: a second pass (a loop through this same node) is refused. A crash between the write and this record leaves it consumed but not applied: only this node may retry; any other step or run needs a NEW approval.
        await ctx.tasks.markApplied(ctx.tenant, c.approvalTaskId, `${ctx.runId}:${ctx.nodeId}`, String(r.revision));
        ctx.log(`approved reset applied on the run branch for "${c.subject}" (revision ${String(r.revision).slice(0, 8)}, ${c.hours} h); not active until published`);
        return { subject: c.subject, revision: String(r.revision), expiresAt: r.expiresAt, hours: Number(c.hours) };
    },
};

export const LYAM_ADMIN_BLOCKS = [
    // P0
    lyamRequestApproval,
    lyamReadUser, lyamSearchUsers, lyamListRoles, lyamListAssignments, lyamSimulateAssignment, lyamListOrganizations, lyamListApplications, lyamReadProfileSchema,
    lyamUpdateUser, lyamSetLoginEnabled, lyamCreateRole, lyamProposeRoleRemoval,
    igaCreateCampaign, igaListItems, igaOpenReviewTasks, igaAwaitDecisions, igaPrepareRemediation, igaMarkRemediated, igaCloseCampaign, igaReadCampaign, igaReadOverdue, igaReassignReviews,
    lyamGrantAssignment, lyamRevokeAssignment,
    lyamReadDiff, lyamRequestPublish,
    // P1
    lyamCreateOrganization, lyamAssignOrganization, lyamCreateApplication, lyamCheckAccountBlocks, lyamStartWorkflow, lyamReadRun,
    // P2
    lyamValidatePolicy, lyamProposePolicyChange, lyamReadPluginStates, lyamProposePluginChange, lyamListDelegations, lyamRevokeDelegationRequest,
    // Completion of the brief's partial families
    lyamOrgImpact, lyamRemoveOrgMember, lyamProposeOrgRemoval,
    lyamSetApplicationEnabled, lyamSetApplicationRoles, lyamProposeApplicationRemoval,
    lyamImportCsv, lyamImportScim,
    lyamReadMailTemplates, lyamPreviewMailTemplate, lyamProposeMailTemplate, lyamPreviewTheme, lyamProposeTheme,
    lyamReadAuthn, lyamReadEnrollments, lyamProposeAuthnPolicy, lyamRequestReenrollment, lyamProposePasswordReset, lyamApplyPasswordReset,
];
