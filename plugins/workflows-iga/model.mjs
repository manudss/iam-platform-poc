import { createRequire } from 'node:module';
// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
export const STEP_CATEGORIES = ['simulated', 'computed', 'real'];
/**
 * Display category of a step type, shown as the node/run badge:
 *   simulated  nothing really happens (a notification is only logged, never sent)
 *   computed   the step REALLY runs and computes its output, but has no external effect and writes nothing
 *   real       external call or data write (on the run branch)
 * `simulated` (the boolean) keeps its engine meaning: no external effect, no write. The category refines the badge.
 */
export const stepCategory = (type) => STEP_TYPES[type]?.category ?? (STEP_TYPES[type]?.simulated ? 'simulated' : 'real');
/**
 * Flow-control ("Logic") step types: they really evaluate something at run time but have no external
 * effect (category computed) and never write data, so `simulated` stays true for the engine's branch
 * creation rules. Their outgoing links carry a `label` the run follows:
 *  - if:     labels true / false, from the condition result
 *  - switch: labels = one of its cases, or default
 *  - loop:   labels each (the body, run once per item) / done (the continuation after the loop)
 *  - merge:  joins paths: runs as soon as ONE incoming link arrives (other steps need ALL of them)
 * Every step type may also have an `error` link: taken when the step fails, instead of failing the run.
 */
export const LOGIC_TYPES = ['if', 'switch', 'loop', 'merge'];
export const STEP_TYPES = {
    wait: { simulated: true, category: 'simulated', label: 'Wait (simulated delay)' },
    if: { simulated: true, category: 'computed', label: 'If (condition)' },
    switch: { simulated: true, category: 'computed', label: 'Switch (multi-branch)' },
    loop: { simulated: true, category: 'computed', label: 'Loop (for each item)' },
    merge: { simulated: true, category: 'computed', label: 'Merge (join paths)' },
    notify: { simulated: true, category: 'simulated', label: 'Notify (simulated, nothing sent)' },
    fail: { simulated: true, category: 'simulated', label: 'Fail on purpose (simulated error)' },
    'assign-role': { simulated: false, category: 'real', label: 'Assign a role (real, on the run branch)' },
    'revoke-role': { simulated: false, category: 'real', label: 'Revoke a role (real, on the run branch)' },
    'set-department': { simulated: false, category: 'real', label: 'Set department (real, on the run branch)' },
    'set-profile-field': { simulated: false, category: 'real', label: 'Set a profile field (real, on the run branch)' },
};
/**
 * Application events a workflow can start on (its "start trigger"). This is the hook catalog the
 * editor offers; each event names the payload keys that {{event.<key>}} placeholders resolve from.
 * Events fire after a real application write; a triggered run still writes only on its own Dolt branch.
 */
export const WF_EVENTS = {
    'user.created': { label: 'A user is created (joiner)', payload: ['subject', 'displayName', 'department', 'email'] },
    'user.department-changed': { label: "A user's department changes (mover)", payload: ['subject', 'from', 'to'] },
    'user.disabled': { label: 'A user account is disabled (leaver)', payload: ['subject'] },
    'signup.requested': { label: 'A sign-up request is submitted (registration)', payload: ['subject', 'email'] },
    'signup.approved': { label: 'A sign-up request is approved', payload: ['subject', 'email'] },
    'profile.updated': { label: "A user's profile values are updated", payload: ['subject', 'keys', 'actor'] },
    'profile.review-resolved': { label: 'A profile edit review is accepted or refused', payload: ['subject', 'decision', 'actor'] },
    'organization.member-added': { label: 'A user joins an organization', payload: ['subject', 'organization', 'actor'] },
    'app.registered': { label: 'An application is registered for SSO', payload: ['app', 'protocol', 'actor'] },
    'app.updated': { label: "An application's SSO configuration changes", payload: ['app', 'protocol', 'actor'] },
    'sso.login.succeeded': { label: 'A user signed in to an application (SSO)', payload: ['app', 'subject'] },
    'sso.login.denied': { label: 'A user was refused access to an application (SSO)', payload: ['app', 'subject', 'reason'] },
    'sso.login.failed': { label: 'An SSO authorization request failed', payload: ['app', 'subject', 'reason'] },
    'sso.token.issued': { label: 'Tokens were issued to an application (SSO)', payload: ['app', 'subject', 'scope'] },
    'app.removed': { label: 'An application is removed from SSO', payload: ['app', 'protocol', 'actor'] },
};
const PLACEHOLDER = /\{\{event\.([a-zA-Z]+)\}\}/g;
/** Placeholder keys used in a config string, e.g. "{{event.subject}}" -> ["subject"]. */
export function placeholderKeys(value) {
    if (typeof value !== 'string')
        return [];
    return [...value.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].map((m) => m[1]);
}
const STEP_PLACEHOLDER = /\{\{steps\.([a-z0-9-]+)\.([a-zA-Z0-9_]+)\}\}/g;
/** Upstream-output placeholders used in a config string, e.g. "{{steps.read.rowNumber}}" -> [{node, key}]. */
export function stepPlaceholderRefs(value) {
    if (typeof value !== 'string')
        return [];
    return [...value.matchAll(new RegExp(STEP_PLACEHOLDER.source, 'g'))].map((m) => ({ node: m[1], key: m[2] }));
}
/** Replaces {{steps.<node>.<key>}} placeholders from the outputs of already-finished steps (engine, at step time).
 * A missing step or key refuses the step with a clear error. Objects are injected as JSON. */
export function substituteStepOutputs(node, outputs) {
    const config = {};
    for (const [k, v] of Object.entries(node.config)) {
        if (typeof v !== 'string') { config[k] = v; continue; }
        config[k] = v.replace(new RegExp(STEP_PLACEHOLDER.source, 'g'), (_m, id, key) => {
            const out = outputs[id];
            if (out === undefined || out === null)
                throw new BadRequestException(`step "${node.id}": {{steps.${id}.${key}}} cannot resolve: step "${id}" produced no output`);
            const val = out[key];
            if (val === undefined)
                throw new BadRequestException(`step "${node.id}": {{steps.${id}.${key}}} cannot resolve: no key "${key}" in the output of "${id}" (has: ${Object.keys(out).join(', ') || 'none'})`);
            return typeof val === 'object' ? JSON.stringify(val) : String(val);
        });
    }
    return { ...node, config };
}
/** Save-time check: every {{steps.<id>.<key>}} must reference a step that comes EARLIER in the execution order. */
export function validateStepPlaceholders(graph, order) {
    const position = new Map(order.map((id, i) => [id, i]));
    for (const n of graph.nodes) {
        for (const v of Object.values(n.config)) {
            for (const ref of stepPlaceholderRefs(v)) {
                if (!position.has(ref.node))
                    throw new BadRequestException(`step "${n.id}": {{steps.${ref.node}.${ref.key}}} references an unknown step "${ref.node}"`);
                if (position.get(ref.node) >= position.get(n.id))
                    throw new BadRequestException(`step "${n.id}": {{steps.${ref.node}.${ref.key}}} references "${ref.node}", which does not run before it (link the steps so the value exists)`);
            }
        }
    }
}

// ---- External catalogue (workflows.blocks providers, e.g. the workflow-connectors plugin) ----
// Blocks and trigger events contributed by other plugins are MERGED here at boot by the core adapter
// (apps/api/src/workflows/model.ts): STEP_TYPES and WF_EVENTS are live objects so every importer sees
// the merged catalogue. A contributed block carries validate(config) and run(ctx); its provider plugin
// id is recorded so save/start/run can refuse it while the provider is disabled.
const EXTERNAL_BLOCK_PROVIDER = new Map(); // type -> provider plugin id
const EXTERNAL_BLOCK_IMPL = new Map();     // type -> descriptor { fields, outputs, validate, run, description }
const EXTERNAL_EVENT_IMPL = new Map();     // event -> descriptor { configFields, poll }
export function registerExternalBlocks(blocks) {
    for (const b of blocks ?? []) {
        if (!b || typeof b.type !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(b.type))
            throw new Error(`external block: invalid type ${b?.type}`);
        if (STEP_TYPES[b.type])
            throw new Error(`external block "${b.type}" collides with an existing step type`);
        if (typeof b.validate !== 'function' || typeof b.run !== 'function')
            throw new Error(`external block "${b.type}": validate and run functions are required`);
        const category = b.category ?? (b.simulated ? 'simulated' : 'real');
        if (!STEP_CATEGORIES.includes(category))
            throw new Error(`external block "${b.type}": category must be one of ${STEP_CATEGORIES.join(', ')}`);
        STEP_TYPES[b.type] = { simulated: !!b.simulated, category, label: String(b.label ?? b.type) };
        EXTERNAL_BLOCK_PROVIDER.set(b.type, b.pluginId);
        EXTERNAL_BLOCK_IMPL.set(b.type, b);
    }
}
export function registerExternalEvents(events) {
    for (const [event, d] of Object.entries(events ?? {})) {
        if (WF_EVENTS[event])
            throw new Error(`external trigger "${event}" collides with an existing event`);
        WF_EVENTS[event] = { label: String(d.label ?? event), payload: Array.isArray(d.payload) ? d.payload : ['*'], configFields: Array.isArray(d.configFields) ? d.configFields : [] };
        EXTERNAL_EVENT_IMPL.set(event, d);
    }
}
export const externalBlock = (type) => EXTERNAL_BLOCK_IMPL.get(type);
export const externalBlockProvider = (type) => EXTERNAL_BLOCK_PROVIDER.get(type);
export const externalEvent = (event) => EXTERNAL_EVENT_IMPL.get(event);
export const isWildcardEvent = (event) => (WF_EVENTS[event]?.payload ?? []).includes('*');
/** Validates the trigger-level `config` object of an external event against its declared configFields. */
function validateTriggerConfig(event, config) {
    const desc = EXTERNAL_EVENT_IMPL.get(event);
    const fields = desc?.configFields ?? [];
    if (config === undefined || config === null)
        config = {};
    if (typeof config !== 'object' || Array.isArray(config))
        throw new BadRequestException('trigger.config must be an object');
    const known = new Set(fields.map((f) => f.key));
    for (const k of Object.keys(config))
        if (!known.has(k))
            throw new BadRequestException(`trigger.config: unknown key "${k}" for ${event} (known: ${[...known].join(', ') || 'none'})`);
    const out = {};
    for (const f of fields) {
        let v = config[f.key] ?? f.default;
        if (v === undefined || v === null || v === '') {
            if (f.required)
                throw new BadRequestException(`trigger.config.${f.key} is required for ${event}`);
            continue;
        }
        if (f.type === 'number') {
            v = Number(v);
            if (!Number.isFinite(v))
                throw new BadRequestException(`trigger.config.${f.key}: a number`);
        }
        else {
            v = String(v);
            if (v.length > 200)
                throw new BadRequestException(`trigger.config.${f.key}: text up to 200 characters`);
            if (f.options && !f.options.includes(v))
                throw new BadRequestException(`trigger.config.${f.key}: one of ${f.options.join(', ')}`);
            if (f.key === 'token' && v.length < 12 && !v.includes('{{'))
                throw new BadRequestException('trigger.config.token: at least 12 characters (it is the webhook credential)');
        }
        out[f.key] = v;
    }
    return out;
}
/** Validates a trigger object (or null/undefined = manual start only). Match keys must exist in the event payload. */
export function validateTrigger(input) {
    if (input === undefined || input === null)
        return null;
    if (typeof input !== 'object' || Array.isArray(input))
        throw new BadRequestException('trigger must be an object {event, match?, config?} or null');
    const t = input;
    if (Object.keys(t).some((k) => !TRIGGER_KEYS.includes(k)))
        throw new BadRequestException(`trigger: only ${TRIGGER_KEYS.join(', ')} are allowed`);
    if (t.cron !== undefined && t.cron !== null) {
        if (t.event !== undefined && t.event !== null && t.event !== '')
            throw new BadRequestException('trigger: cron and event are exclusive (a schedule or an event, not both)');
        if (t.match !== undefined && t.match !== null)
            throw new BadRequestException('trigger.match needs an event payload to match on: it has no meaning on a cron trigger');
        if (t.config !== undefined && t.config !== null)
            throw new BadRequestException('trigger.config needs an external event: it has no meaning on a cron trigger');
        return { cron: validateCronExpression(t.cron) };
    }
    const event = String(t.event ?? '');
    if (!Object.hasOwn(WF_EVENTS, event))
        throw new BadRequestException(`trigger.event: unknown event "${event}" (known: ${Object.keys(WF_EVENTS).join(', ')})`);
    const out = { event };
    if (t.config !== undefined || isWildcardEvent(event))
        out.config = validateTriggerConfig(event, t.config);
    if (t.match !== undefined && t.match !== null) {
        if (typeof t.match !== 'object' || Array.isArray(t.match))
            throw new BadRequestException('trigger.match must be an object of payload filters');
        const match = {};
        for (const [k, v] of Object.entries(t.match)) {
            if (!isWildcardEvent(event) && !WF_EVENTS[event].payload.includes(k))
                throw new BadRequestException(`trigger.match: "${k}" is not a payload key of ${event} (${WF_EVENTS[event].payload.join(', ')})`);
            if (typeof v !== 'string' || !v || v.length > 40)
                throw new BadRequestException('trigger.match: values are texts of 1 to 40 characters');
            match[k] = v;
        }
        if (Object.keys(match).length)
            out.match = match;
    }
    return out;
}


// ---- Cron triggers (phase 3): a definition can start on a schedule instead of an event. Five fields
// (minute hour day-of-month month day-of-week), Europe/Paris, no catch-up after a downtime: only the
// minutes that match while the server runs fire a run. ----
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
/** Parses one cron field into the set of matching values. Supports *, lists, ranges and /steps. */
function cronField(field, [lo, hi], what) {
    const out = new Set();
    for (const part of field.split(',')) {
        const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
        if (!m) throw new BadRequestException(`cron: "${part}" is not a valid ${what} field (use *, numbers, ranges, steps)`);
        const step = m[2] === undefined ? 1 : Number(m[2]);
        if (!Number.isInteger(step) || step < 1) throw new BadRequestException(`cron: invalid step in "${part}"`);
        let a = lo, b = hi;
        if (m[1] !== '*') {
            const [x, y] = m[1].split('-').map(Number);
            a = x; b = y === undefined ? x : y;
            if (a < lo || b > hi || a > b) throw new BadRequestException(`cron: "${part}" is out of range for ${what} (${lo}-${hi})`);
        }
        for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 7 ? 0 : v); // day-of-week: 0 and 7 are both Sunday
    }
    if (!out.size) throw new BadRequestException(`cron: empty ${what} field`);
    return out;
}
/** A parsed 5-field cron expression: Sets for minute, hour, day-of-month, month, day-of-week. */
export function parseCron(expr) {
    const fields = String(expr ?? '').trim().split(/\s+/);
    if (fields.length !== 5) throw new BadRequestException('cron: five fields expected (minute hour day-of-month month day-of-week), e.g. "0 6 * * *"');
    const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];
    return fields.map((f, i) => cronField(f, CRON_RANGES[i], names[i]));
}
const PARIS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Europe/Paris wall-clock parts of a timestamp (the cron evaluation timezone). */
export function parisParts(ms) {
    const p = {};
    for (const part of PARIS.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = part.value;
    return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), weekday: WD[p.weekday] ?? 0 };
}
/** True when the Paris wall-clock minute of `ms` matches the parsed expression. Standard cron rule:
 * when BOTH day-of-month and day-of-week are restricted, either one matching is enough. */
export function cronMatches(parsed, ms, domRestricted, dowRestricted) {
    const p = parisParts(ms);
    if (!parsed[0].has(p.minute) || !parsed[1].has(p.hour) || !parsed[3].has(p.month)) return false;
    const dom = parsed[2].has(p.day), dow = parsed[4].has(p.weekday);
    return domRestricted && dowRestricted ? dom || dow : dom && dow;
}
/** The next instant (ms) whose Paris minute matches the expression, searching up to 366 days ahead. */
export function nextCronFire(expr, fromMs = Date.now()) {
    const parsed = parseCron(expr);
    const domRestricted = !/^\*(\/\d+)?$/.test(String(expr).trim().split(/\s+/)[2]);
    const dowRestricted = !/^\*(\/\d+)?$/.test(String(expr).trim().split(/\s+/)[4]);
    let t = Math.floor(fromMs / 60000) * 60000 + 60000; // the next full minute
    const limit = t + 366 * 24 * 3600 * 1000;
    while (t < limit) {
        const p = parisParts(t);
        if (!parsed[3].has(p.month)) { t += 24 * 3600 * 1000; continue; } // skip whole days until an allowed month
        const dom = parsed[2].has(p.day), dow = parsed[4].has(p.weekday);
        if (!(domRestricted && dowRestricted ? dom || dow : dom && dow)) { t += 24 * 3600 * 1000; continue; }
        if (parsed[1].has(p.hour) && parsed[0].has(p.minute)) return t;
        t += 60000;
    }
    throw new BadRequestException('cron: no matching time within a year');
}
/** Validates a cron expression string and returns it normalized (single spaces). */
export function validateCronExpression(expr) {
    const e = String(expr ?? '').trim().replace(/\s+/g, ' ');
    parseCron(e); // throws on any malformed field
    return e;
}

/** The keys allowed in a trigger object (event + match + config for external events, or cron for a schedule). */
export const TRIGGER_KEYS = ['event', 'match', 'config', 'cron'];
/** Resolves {{event.<key>}} placeholders in every config string of the graph. Unknown keys refuse the run start. */
export function substituteEventPayload(graph, payload) {
    const nodes = graph.nodes.map((n) => {
        const config = {};
        for (const [k, v] of Object.entries(n.config)) {
            if (typeof v !== 'string') {
                config[k] = v;
                continue;
            }
            config[k] = v.replace(new RegExp(PLACEHOLDER.source, 'g'), (_m, key) => {
                const val = payload[key];
                if (val === undefined)
                    throw new BadRequestException(`step "${n.id}": no value for {{event.${key}}} in the triggering event`);
                return val;
            });
        }
        return { ...n, config };
    });
    return { nodes, edges: graph.edges.map((e) => ({ ...e })) };
}
const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NAME32 = /^[a-z0-9-]{1,32}$/;
function str(v, what, max, required = true) {
    if (v === undefined || v === null || v === '') {
        if (required)
            throw new BadRequestException(`${what} is required`);
        return '';
    }
    if (typeof v !== 'string' || v.length > max)
        throw new BadRequestException(`${what}: text up to ${max} characters`);
    return v;
}
/** Operators of the if step, evaluated on the RESOLVED strings (placeholders already substituted). */
export const IF_OPERATORS = ['equals', 'not-equals', 'contains', 'not-contains', 'starts-with', 'ends-with', 'gt', 'lt', 'empty', 'not-empty'];
/** Config form fields of the flow-control blocks, rendered by the editor's Settings drawer (keys must
 *  match what the engine reads: if left/op/right, switch value/cases, loop items/maxItems, merge none). */
export const LOGIC_FIELDS = {
    if: [
        { key: 'left', label: 'Left value', type: 'string', required: true, help: 'Placeholders allowed, e.g. {{event.department}} or {{steps.read.email}}' },
        { key: 'op', label: 'Operator', type: 'select', required: true, default: 'equals', options: IF_OPERATORS },
        { key: 'right', label: 'Right value', type: 'string', help: 'Not used by the empty / not-empty operators' },
    ],
    switch: [
        { key: 'value', label: 'Value to branch on', type: 'string', required: true, help: 'Placeholders allowed, e.g. {{event.department}}' },
        { key: 'cases', label: 'Cases (one per line or comma-separated)', type: 'text', required: true, help: 'Outgoing links carry a case label; an unmatched value takes the default link' },
    ],
    loop: [
        { key: 'items', label: 'Items (JSON array or list)', type: 'text', required: true, help: 'A JSON array, or one item per line / comma-separated; placeholders allowed' },
        { key: 'maxItems', label: 'Max items per run (safety cap)', type: 'number', default: 10 },
    ],
    merge: [],
};
const EDGE_LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** The case labels of a switch step, from its newline/comma-separated config list. */
export function switchCases(raw) {
    const out = [];
    for (const part of String(raw ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
        if (!EDGE_LABEL.test(part))
            throw new BadRequestException(`switch.cases: "${part}" is not a usable link label (lowercase letters, digits, hyphens)`);
        if (part === 'default' || part === 'error' || part === 'each' || part === 'done' || part === 'true' || part === 'false')
            throw new BadRequestException(`switch.cases: "${part}" is a reserved label`);
        if (!out.includes(part))
            out.push(part);
    }
    if (!out.length || out.length > 10)
        throw new BadRequestException('switch.cases: 1 to 10 case labels (newline or comma separated)');
    return out;
}

/** Validates one node's config for its type. Unknown keys are rejected so a definition cannot smuggle behavior. */
function configFor(type, cfg) {
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))
        throw new BadRequestException('config must be an object');
    const out = {};
    switch (type) {
        case 'if': {
            out.left = str(cfg.left, 'if.left', 200);
            const op = str(cfg.op, 'if.op', 20);
            if (!IF_OPERATORS.includes(op))
                throw new BadRequestException(`if.op: one of ${IF_OPERATORS.join(', ')}`);
            out.op = op;
            if (op !== 'empty' && op !== 'not-empty')
                out.right = str(cfg.right, 'if.right', 200);
            break;
        }
        case 'switch': {
            out.value = str(cfg.value, 'switch.value', 200);
            out.cases = switchCases(cfg.cases).join('\n');
            break;
        }
        case 'loop': {
            out.items = str(cfg.items, 'loop.items', 500);
            const max = cfg.maxItems === undefined || cfg.maxItems === '' ? 10 : Number(cfg.maxItems);
            if (!Number.isFinite(max) || max < 1 || max > 50)
                throw new BadRequestException('loop.maxItems: 1 to 50');
            out.maxItems = Math.floor(max);
            break;
        }
        case 'merge':
            break;
        case 'wait': {
            const seconds = cfg.seconds === undefined ? 2 : Number(cfg.seconds);
            if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
                throw new BadRequestException('wait.seconds: 0 to 60');
            out.seconds = Math.floor(seconds);
            break;
        }
        case 'notify':
            out.recipient = str(cfg.recipient, 'notify.recipient', 80);
            out.message = str(cfg.message, 'notify.message', 200);
            break;
        case 'fail': {
            out.message = str(cfg.message, 'fail.message', 200, false) || 'step configured to fail';
            const mode = str(cfg.mode, 'fail.mode', 10, false) || 'once';
            if (mode !== 'once' && mode !== 'always')
                throw new BadRequestException('fail.mode: "once" (recovers on retry) or "always"');
            out.mode = mode;
            break;
        }
        case 'assign-role':
        case 'revoke-role': {
            const identity = str(cfg.identity, `${type}.identity`, 64), role = str(cfg.role, `${type}.role`, 64);
            for (const [k, v] of [['identity', identity], ['role', role]])
                if (!NAME32.test(v) && !placeholderKeys(v).length && !stepPlaceholderRefs(v).length)
                    throw new BadRequestException(`${type}: ${k} uses lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders`);
            out.identity = identity;
            out.role = role;
            break;
        }
        case 'set-department': {
            const identity = str(cfg.identity, 'set-department.identity', 64);
            if (!NAME32.test(identity) && !placeholderKeys(identity).length && !stepPlaceholderRefs(identity).length)
                throw new BadRequestException('set-department.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
            out.identity = identity;
            out.department = str(cfg.department, 'set-department.department', 40);
            break;
        }
        case 'set-profile-field': {
            const identity = str(cfg.identity, 'set-profile-field.identity', 64);
            if (!NAME32.test(identity) && !placeholderKeys(identity).length && !stepPlaceholderRefs(identity).length)
                throw new BadRequestException('set-profile-field.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
            out.identity = identity;
            const field = str(cfg.field, 'set-profile-field.field', 80);
            if (!/^[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9_]{1,40}$/.test(field))
                throw new BadRequestException('set-profile-field.field: a profile field key like "hr-attributes.employee_grade"');
            out.field = field;
            out.value = str(cfg.value, 'set-profile-field.value', 200);
            break;
        }
        default: {
            const external = EXTERNAL_BLOCK_IMPL.get(type);
            if (external) {
                const managed = /^(google-sheets-|jira-)/.test(type) || type === 'http-request';
                const actionCfg = { ...cfg };
                if (managed) for (const k of ['executionMode', 'connectionId', 'realConfirmed']) delete actionCfg[k];
                const clean = external.validate(actionCfg);
                if (managed) {
                    const mode = cfg.executionMode ?? 'simulation';
                    if (!['simulation', 'real'].includes(mode)) throw new BadRequestException('executionMode: simulation or real');
                    if (cfg.connectionId !== undefined && cfg.connectionId !== '' && (typeof cfg.connectionId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(cfg.connectionId))) throw new BadRequestException('invalid connection id');
                    if (mode === 'real' && (!cfg.connectionId || cfg.realConfirmed !== true)) throw new BadRequestException('Real requires a managed connection and explicit confirmation');
                    clean.executionMode = mode; clean.connectionId = cfg.connectionId ?? ''; clean.realConfirmed = mode === 'real' && cfg.realConfirmed === true;
                }
                const known = new Set(Object.keys(clean));
                for (const k of Object.keys(cfg))
                    if (!known.has(k))
                        throw new BadRequestException(`${type}: unknown config key "${k}"`);
                return clean;
            }
            break;
        }
    }
    const allowed = new Set(Object.keys(out));
    for (const k of Object.keys(cfg))
        if (!allowed.has(k))
            throw new BadRequestException(`${type}: unknown config key "${k}"`);
    return out;
}
/** Validates the graph and returns the topological execution order (Kahn). Refuses cycles, dangling edges, unknown types. */
export function validateGraph(input) {
    const g = input;
    if (typeof g !== 'object' || g === null)
        throw new BadRequestException('a graph is required');
    const nodes = Array.isArray(g.nodes) ? g.nodes : [];
    const edges = Array.isArray(g.edges) ? g.edges : [];
    if (nodes.length < 1 || nodes.length > 20)
        throw new BadRequestException('1 to 20 steps');
    if (edges.length > 60)
        throw new BadRequestException('too many links (max 60)');
    const byId = new Map();
    const clean = [];
    for (const n of nodes) {
        if (typeof n !== 'object' || n === null)
            throw new BadRequestException('invalid step');
        const id = String(n.id ?? '');
        if (!ID.test(id))
            throw new BadRequestException(`invalid step id "${id}" (lowercase letters, digits, hyphens)`);
        if (byId.has(id))
            throw new BadRequestException(`duplicate step id "${id}"`);
        const type = n.type;
        if (!Object.hasOwn(STEP_TYPES, type))
            throw new BadRequestException(`unknown step type "${type}"`);
        const name = str(n.name, `step "${id}" name`, 80);
        const cfg = configFor(type, n.config ?? {});
        const node = { id, type: type, name, config: cfg };
        byId.set(id, node);
        clean.push(node);
    }
    const indeg = new Map(clean.map((n) => [n.id, 0]));
    const out = new Map(clean.map((n) => [n.id, []]));
    const seen = new Set();
    const cleanEdges = [];
    for (const e of edges) {
        const from = String(e?.from ?? ''), to = String(e?.to ?? '');
        if (!byId.has(from) || !byId.has(to))
            throw new BadRequestException(`link ${from} -> ${to} references an unknown step`);
        if (from === to)
            throw new BadRequestException(`step "${from}" cannot link to itself`);
        const label = e?.label === undefined || e?.label === null || e?.label === '' ? undefined : String(e.label);
        if (label !== undefined) {
            if (!EDGE_LABEL.test(label))
                throw new BadRequestException(`link label "${label}": lowercase letters, digits, hyphens (max 31)`);
            if (label !== 'error') {
                const fromType = byId.get(from).type;
                if (fromType === 'if') {
                    if (label !== 'true' && label !== 'false')
                        throw new BadRequestException(`an if step only branches on links labeled true or false (got "${label}")`);
                }
                else if (fromType === 'switch') {
                    const cases = switchCases(byId.get(from).config.cases);
                    if (label !== 'default' && !cases.includes(label))
                        throw new BadRequestException(`link label "${label}" is not a case of the switch step (cases: ${cases.join(', ')}, or default)`);
                }
                else if (fromType === 'loop') {
                    if (label !== 'each' && label !== 'done')
                        throw new BadRequestException(`a loop step only branches on links labeled each (the body) or done (after the loop) (got "${label}")`);
                }
                else
                    throw new BadRequestException(`link labels are only meaningful on if/switch/loop steps; other steps only support the "error" label (got "${label}" on a ${fromType} step)`);
            }
        }
        const key = `${from}->${to}:${label ?? ''}`;
        if (seen.has(key))
            continue; // duplicate link: harmless, kept once
        seen.add(key);
        out.get(from).push(to);
        indeg.set(to, indeg.get(to) + 1);
        cleanEdges.push(label === undefined ? { from, to } : { from, to, label });
    }
    // Flow-control shape: each logic step needs its branch links; loops cannot nest. An unlabeled link
    // leaving an if/switch/loop step would never be taken (the step chooses a branch label), so refuse it.
    for (const n of clean) {
        if (LOGIC_TYPES.includes(n.type) && n.type !== 'merge')
            for (const e of cleanEdges)
                if (e.from === n.id && e.label === undefined)
                    throw new BadRequestException(`step "${n.id}" (${n.type}) chooses a branch: every outgoing link needs a label (${n.type === 'if' ? 'true or false' : n.type === 'switch' ? 'a case or default' : 'each or done'}, or error)`);
        const outLabels = cleanEdges.filter((e) => e.from === n.id && e.label !== 'error').map((e) => e.label);
        if (n.type === 'if' && !outLabels.some((l) => l === 'true' || l === 'false'))
            throw new BadRequestException(`if step "${n.id}" needs at least one outgoing link labeled true or false`);
        if (n.type === 'switch' && !outLabels.some((l) => l !== undefined))
            throw new BadRequestException(`switch step "${n.id}" needs at least one outgoing link labeled with a case or default`);
        if (n.type === 'loop') {
            if (!outLabels.some((l) => l === 'each'))
                throw new BadRequestException(`loop step "${n.id}" needs an outgoing link labeled each (the body run per item)`);
            if ([...loopBody({ nodes: clean, edges: cleanEdges }, n.id)].some((id) => byId.get(id).type === 'loop'))
                throw new BadRequestException(`loop step "${n.id}": nested loops are not supported`);
        }
    }
    const queue = clean.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    const order = [];
    const ind = new Map(indeg);
    while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const to of out.get(id)) {
            ind.set(to, ind.get(to) - 1);
            if (ind.get(to) === 0)
                queue.push(to);
        }
    }
    if (order.length !== clean.length)
        throw new BadRequestException('the graph has a cycle: a workflow must be a directed acyclic graph');
    return { graph: { nodes: clean, edges: cleanEdges }, order };
}
export function hasDataSteps(g) {
    return g.nodes.some((n) => !STEP_TYPES[n.type].simulated);
}

/** The body of a loop step: every node reachable through its `each` links that is NOT also reachable
 * through its `done` links (the continuation). Returned as a Set of node ids (order comes from validateGraph). */
export function loopBody(graph, loopId) {
    const descendantsFrom = (startIds) => {
        const seen = new Set(startIds);
        const queue = [...startIds];
        while (queue.length) {
            const id = queue.shift();
            for (const e of graph.edges)
                if (e.from === id && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
        }
        return seen;
    };
    const eachStarts = graph.edges.filter((e) => e.from === loopId && e.label === 'each').map((e) => e.to);
    const doneStarts = graph.edges.filter((e) => e.from === loopId && e.label === 'done').map((e) => e.to);
    const throughDone = descendantsFrom(doneStarts);
    const body = new Set();
    for (const id of descendantsFrom(eachStarts))
        if (id !== loopId && !throughDone.has(id))
            body.add(id);
    return body;
}
