import { createRequire } from 'node:module';
// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');
export const STEP_TYPES = {
    wait: { simulated: true, label: 'Wait (simulated delay)' },
    notify: { simulated: true, label: 'Notify (simulated, nothing sent)' },
    fail: { simulated: true, label: 'Fail on purpose (simulated error)' },
    'assign-role': { simulated: false, label: 'Assign a role (real, on the run branch)' },
    'revoke-role': { simulated: false, label: 'Revoke a role (real, on the run branch)' },
    'set-department': { simulated: false, label: 'Set department (real, on the run branch)' },
    'set-profile-field': { simulated: false, label: 'Set a profile field (real, on the run branch)' },
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
/** Validates a trigger object (or null/undefined = manual start only). Match keys must exist in the event payload. */
export function validateTrigger(input) {
    if (input === undefined || input === null)
        return null;
    if (typeof input !== 'object' || Array.isArray(input))
        throw new BadRequestException('trigger must be an object {event, match?} or null');
    const t = input;
    if (Object.keys(t).some((k) => !['event', 'match'].includes(k)))
        throw new BadRequestException('trigger: only event and match are allowed');
    const event = String(t.event ?? '');
    if (!Object.hasOwn(WF_EVENTS, event))
        throw new BadRequestException(`trigger.event: unknown event "${event}" (known: ${Object.keys(WF_EVENTS).join(', ')})`);
    const out = { event };
    if (t.match !== undefined && t.match !== null) {
        if (typeof t.match !== 'object' || Array.isArray(t.match))
            throw new BadRequestException('trigger.match must be an object of payload filters');
        const match = {};
        for (const [k, v] of Object.entries(t.match)) {
            if (!WF_EVENTS[event].payload.includes(k))
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
/** Validates one node's config for its type. Unknown keys are rejected so a definition cannot smuggle behavior. */
function configFor(type, cfg) {
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg))
        throw new BadRequestException('config must be an object');
    const out = {};
    switch (type) {
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
                if (!NAME32.test(v) && !placeholderKeys(v).length)
                    throw new BadRequestException(`${type}: ${k} uses lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders`);
            out.identity = identity;
            out.role = role;
            break;
        }
        case 'set-department': {
            const identity = str(cfg.identity, 'set-department.identity', 64);
            if (!NAME32.test(identity) && !placeholderKeys(identity).length)
                throw new BadRequestException('set-department.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
            out.identity = identity;
            out.department = str(cfg.department, 'set-department.department', 40);
            break;
        }
        case 'set-profile-field': {
            const identity = str(cfg.identity, 'set-profile-field.identity', 64);
            if (!NAME32.test(identity) && !placeholderKeys(identity).length)
                throw new BadRequestException('set-profile-field.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
            out.identity = identity;
            const field = str(cfg.field, 'set-profile-field.field', 80);
            if (!/^[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9_]{1,40}$/.test(field))
                throw new BadRequestException('set-profile-field.field: a profile field key like "hr-attributes.employee_grade"');
            out.field = field;
            out.value = str(cfg.value, 'set-profile-field.value', 200);
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
        const key = `${from}->${to}`;
        if (seen.has(key))
            continue; // duplicate link: harmless, kept once
        seen.add(key);
        out.get(from).push(to);
        indeg.set(to, indeg.get(to) + 1);
        cleanEdges.push({ from, to });
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
