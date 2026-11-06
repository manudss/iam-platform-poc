import { BadRequestException } from '@nestjs/common';

/**
 * Workflow definitions are DIRECTED ACYCLIC GRAPHS of typed steps, authored in the visual editor.
 * Two families of steps, never mixed up in the API or the UI:
 *  - SIMULATED steps (wait, notify, fail): they demonstrate the flow but have no external effect
 *    (a "notify" step only writes a log line; nothing is ever sent to anyone).
 *  - REAL data steps (assign-role, revoke-role, set-department): they write business data, always on
 *    the run's own Dolt branch (wf-<run id>), never on main. Publishing stays the existing explicit
 *    review/merge path (pull request / Apply), done by a human, not by the workflow.
 */
export type StepType = 'wait' | 'notify' | 'fail' | 'assign-role' | 'revoke-role' | 'set-department' | 'set-profile-field';

export const STEP_TYPES: Record<StepType, { simulated: boolean; label: string }> = {
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
export const WF_EVENTS: Record<string, { label: string; payload: string[] }> = {
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
  'app.removed': { label: 'An application is removed from SSO', payload: ['app', 'protocol', 'actor'] },
};

/** Start trigger of a definition: run automatically when `event` fires and every `match` key equals the payload value. */
export interface WfTrigger { event: string; match?: Record<string, string> }

const PLACEHOLDER = /\{\{event\.([a-zA-Z]+)\}\}/g;

/** Placeholder keys used in a config string, e.g. "{{event.subject}}" -> ["subject"]. */
export function placeholderKeys(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].map((m) => m[1]);
}

/** Validates a trigger object (or null/undefined = manual start only). Match keys must exist in the event payload. */
export function validateTrigger(input: unknown): WfTrigger | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('trigger must be an object {event, match?} or null');
  const t = input as Record<string, unknown>;
  if (Object.keys(t).some((k) => !['event', 'match'].includes(k))) throw new BadRequestException('trigger: only event and match are allowed');
  const event = String(t.event ?? '');
  if (!Object.hasOwn(WF_EVENTS, event)) throw new BadRequestException(`trigger.event: unknown event "${event}" (known: ${Object.keys(WF_EVENTS).join(', ')})`);
  const out: WfTrigger = { event };
  if (t.match !== undefined && t.match !== null) {
    if (typeof t.match !== 'object' || Array.isArray(t.match)) throw new BadRequestException('trigger.match must be an object of payload filters');
    const match: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.match as Record<string, unknown>)) {
      if (!WF_EVENTS[event].payload.includes(k)) throw new BadRequestException(`trigger.match: "${k}" is not a payload key of ${event} (${WF_EVENTS[event].payload.join(', ')})`);
      if (typeof v !== 'string' || !v || v.length > 40) throw new BadRequestException('trigger.match: values are texts of 1 to 40 characters');
      match[k] = v;
    }
    if (Object.keys(match).length) out.match = match;
  }
  return out;
}

/** Resolves {{event.<key>}} placeholders in every config string of the graph. Unknown keys refuse the run start. */
export function substituteEventPayload(graph: WfGraph, payload: Record<string, string>): WfGraph {
  const nodes = graph.nodes.map((n) => {
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.config)) {
      if (typeof v !== 'string') { config[k] = v; continue; }
      config[k] = v.replace(new RegExp(PLACEHOLDER.source, 'g'), (_m, key: string) => {
        const val = payload[key];
        if (val === undefined) throw new BadRequestException(`step "${n.id}": no value for {{event.${key}}} in the triggering event`);
        return val;
      });
    }
    return { ...n, config };
  });
  return { nodes, edges: graph.edges.map((e) => ({ ...e })) };
}

export interface WfNode { id: string; type: StepType; name: string; config: Record<string, unknown> }
export interface WfEdge { from: string; to: string }
export interface WfGraph { nodes: WfNode[]; edges: WfEdge[] }

const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NAME32 = /^[a-z0-9-]{1,32}$/;

function str(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequestException(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`${what}: text up to ${max} characters`);
  return v;
}

/** Validates one node's config for its type. Unknown keys are rejected so a definition cannot smuggle behavior. */
function configFor(type: StepType, cfg: Record<string, unknown>): Record<string, unknown> {
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) throw new BadRequestException('config must be an object');
  const out: Record<string, unknown> = {};
  switch (type) {
    case 'wait': {
      const seconds = cfg.seconds === undefined ? 2 : Number(cfg.seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new BadRequestException('wait.seconds: 0 to 60');
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
      if (mode !== 'once' && mode !== 'always') throw new BadRequestException('fail.mode: "once" (recovers on retry) or "always"');
      out.mode = mode;
      break;
    }
    case 'assign-role':
    case 'revoke-role': {
      const identity = str(cfg.identity, `${type}.identity`, 64), role = str(cfg.role, `${type}.role`, 64);
      for (const [k, v] of [['identity', identity], ['role', role]] as const)
        if (!NAME32.test(v) && !placeholderKeys(v).length) throw new BadRequestException(`${type}: ${k} uses lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders`);
      out.identity = identity; out.role = role;
      break;
    }
    case 'set-department': {
      const identity = str(cfg.identity, 'set-department.identity', 64);
      if (!NAME32.test(identity) && !placeholderKeys(identity).length) throw new BadRequestException('set-department.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
      out.identity = identity;
      out.department = str(cfg.department, 'set-department.department', 40);
      break;
    }
    case 'set-profile-field': {
      const identity = str(cfg.identity, 'set-profile-field.identity', 64);
      if (!NAME32.test(identity) && !placeholderKeys(identity).length) throw new BadRequestException('set-profile-field.identity: lowercase letters, digits, hyphens (max 32), or {{event.<key>}} placeholders');
      out.identity = identity;
      const field = str(cfg.field, 'set-profile-field.field', 80);
      if (!/^[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9_]{1,40}$/.test(field)) throw new BadRequestException('set-profile-field.field: a profile field key like "hr-attributes.employee_grade"');
      out.field = field;
      out.value = str(cfg.value, 'set-profile-field.value', 200);
      break;
    }
  }
  const allowed = new Set(Object.keys(out));
  for (const k of Object.keys(cfg)) if (!allowed.has(k)) throw new BadRequestException(`${type}: unknown config key "${k}"`);
  return out;
}

/** Validates the graph and returns the topological execution order (Kahn). Refuses cycles, dangling edges, unknown types. */
export function validateGraph(input: unknown): { graph: WfGraph; order: string[] } {
  const g = input as WfGraph;
  if (typeof g !== 'object' || g === null) throw new BadRequestException('a graph is required');
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (nodes.length < 1 || nodes.length > 20) throw new BadRequestException('1 to 20 steps');
  if (edges.length > 60) throw new BadRequestException('too many links (max 60)');
  const byId = new Map<string, WfNode>();
  const clean: WfNode[] = [];
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) throw new BadRequestException('invalid step');
    const id = String((n as WfNode).id ?? '');
    if (!ID.test(id)) throw new BadRequestException(`invalid step id "${id}" (lowercase letters, digits, hyphens)`);
    if (byId.has(id)) throw new BadRequestException(`duplicate step id "${id}"`);
    const type = (n as WfNode).type;
    if (!Object.hasOwn(STEP_TYPES, type)) throw new BadRequestException(`unknown step type "${type}"`);
    const name = str((n as WfNode).name, `step "${id}" name`, 80);
    const cfg = configFor(type as StepType, (n as WfNode).config ?? {});
    const node: WfNode = { id, type: type as StepType, name, config: cfg };
    byId.set(id, node); clean.push(node);
  }
  const indeg = new Map<string, number>(clean.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(clean.map((n) => [n.id, []]));
  const seen = new Set<string>();
  const cleanEdges: WfEdge[] = [];
  for (const e of edges) {
    const from = String((e as WfEdge)?.from ?? ''), to = String((e as WfEdge)?.to ?? '');
    if (!byId.has(from) || !byId.has(to)) throw new BadRequestException(`link ${from} -> ${to} references an unknown step`);
    if (from === to) throw new BadRequestException(`step "${from}" cannot link to itself`);
    const key = `${from}->${to}`;
    if (seen.has(key)) continue; // duplicate link: harmless, kept once
    seen.add(key);
    out.get(from)!.push(to);
    indeg.set(to, indeg.get(to)! + 1);
    cleanEdges.push({ from, to });
  }
  const queue = clean.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  const ind = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const to of out.get(id)!) { ind.set(to, ind.get(to)! - 1); if (ind.get(to)! === 0) queue.push(to); }
  }
  if (order.length !== clean.length) throw new BadRequestException('the graph has a cycle: a workflow must be a directed acyclic graph');
  return { graph: { nodes: clean, edges: cleanEdges }, order };
}

export function hasDataSteps(g: WfGraph): boolean {
  return g.nodes.some((n) => !STEP_TYPES[n.type].simulated);
}
