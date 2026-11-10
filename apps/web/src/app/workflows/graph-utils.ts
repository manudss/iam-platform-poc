import { StepCategory, WfBlock, WfEdge, WfEvent, WfNode } from './wf-model';

// ---- Graph helpers for the editor: logic-block metadata, client-side validation (mirrors the server
// rules in plugins/workflows-iga/model.mjs so problems surface before Save), auto-layout, placeholders. ----

export const LOGIC_TYPES = ['if', 'switch', 'loop', 'merge'] as const;
export const isLogicType = (t: string) => (LOGIC_TYPES as readonly string[]).includes(t);

/** Branch labels a step type can emit on its outgoing links ('' = the unlabeled main flow). */
export function outgoingLabels(type: string, config: Record<string, unknown>): string[] {
  if (type === 'if') return ['true', 'false'];
  if (type === 'switch') {
    const cases = String(config['cases'] ?? '').split('\n').map((l) => l.split('=')[0].trim()).filter(Boolean);
    return [...cases, 'default'];
  }
  if (type === 'loop') return ['each', 'done'];
  return [];
}

/** Label choices shown on a link drawn out of a step: the branch labels plus the error path (any step). */
export function edgeLabelChoices(type: string, config: Record<string, unknown>): { value: string; text: string }[] {
  const branch = outgoingLabels(type, config);
  const out = branch.length ? branch.map((l) => ({ value: l, text: l })) : [{ value: '', text: '(main flow)' }];
  out.push({ value: 'error', text: 'on error' });
  return out;
}

/** Default label when a link is drawn out of a logic step: the first branch label not already used. */
export function defaultLabel(type: string, config: Record<string, unknown>, used: (string | undefined)[]): string | undefined {
  const free = outgoingLabels(type, config).filter((l) => !used.includes(l));
  return free[0];
}

/** Ids of the nodes forming a loop body (descendants via 'each' minus descendants via 'done'). */
export function loopBody(nodes: WfNode[], edges: WfEdge[], loopId: string): Set<string> {
  const reach = (fromId: string, label: string): Set<string> => {
    const out = new Set<string>();
    const queue = edges.filter((e) => e.from === fromId && e.label === label).map((e) => e.to);
    while (queue.length) { const c = queue.shift()!; if (out.has(c)) continue; out.add(c); for (const e of edges.filter((x) => x.from === c)) queue.push(e.to); }
    return out;
  };
  const body = reach(loopId, 'each');
  for (const d of reach(loopId, 'done')) body.delete(d);
  body.delete(loopId);
  return body;
}

export interface ValidationIssue { level: 'error' | 'warning'; nodeId?: string; edgeId?: string; message: string }

const PLACEHOLDER_RE = /\{\{\s*(event|steps)\.([^}\s]+)\s*\}\}/g;

/** Placeholders referenced by a text value: [{source:'event'|'steps', path}]. */
export const placeholdersIn = (v: unknown): { source: string; path: string }[] =>
  typeof v !== 'string' ? [] : [...v.matchAll(PLACEHOLDER_RE)].map((m) => ({ source: m[1], path: m[2] }));

/** Ancestor ids of a node (transitive over the links, direction ignored for labels). */
export function ancestorsOf(id: string, edges: WfEdge[]): Set<string> {
  const rev = new Map<string, string[]>();
  for (const e of edges) { const g = rev.get(e.to) ?? []; g.push(e.from); rev.set(e.to, g); }
  const seen = new Set<string>([id]); const queue = [id];
  while (queue.length) { const c = queue.shift()!; for (const p of rev.get(c) ?? []) if (!seen.has(p)) { seen.add(p); queue.push(p); } }
  seen.delete(id);
  return seen;
}

/** Client-side validation shown live in the editor; errors block Save. Mirrors the server-side rules. */
export function validateGraph(
  nodes: WfNode[], edges: WfEdge[], blocks: WfBlock[], events: WfEvent[], triggerEvent: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const blockOf = (t: string) => blocks.find((b) => b.type === t);
  const ev = events.find((e) => e.type === triggerEvent);

  // Cycle detection (direction of the drawn links).
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    color.set(id, 1);
    for (const e of edges.filter((x) => x.from === id)) {
      if (color.get(e.to) === 1) return true;
      if (!color.get(e.to) && visit(e.to)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const n of nodes) if (!color.get(n.id) && visit(n.id)) { issues.push({ level: 'error', message: 'The graph has a cycle: links must flow one way.' }); break; }

  for (const n of nodes) {
    const blk = blockOf(n.type);
    for (const f of blk?.fields ?? []) {
      const v = n.config[f.key];
      if (f.required && (v === undefined || v === null || String(v).trim() === ''))
        issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}": required field "${f.label}" is empty.` });
    }
    // Placeholder references: event keys must exist on the trigger, step references must point upstream.
    for (const f of blk?.fields ?? []) {
      for (const ph of placeholdersIn(n.config[f.key])) {
        if (ph.source === 'event') {
          if (!ev) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}" uses {{event.${ph.path}}} but the workflow has no start trigger.` });
          else if (!ev.payload.includes('*') && !ev.payload.includes(ph.path)) issues.push({ level: 'warning', nodeId: n.id, message: `"${n.name}": {{event.${ph.path}}} is not a documented key of ${ev.type}.` });
        } else {
          const ref = ph.path.split('.')[0];
          if (!byId.has(ref)) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}" references unknown step "${ref}".` });
          else if (!ancestorsOf(n.id, edges).has(ref)) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}" references step "${ref}", which is not upstream of it.` });
        }
      }
    }
    if (nodes.length > 1 && !edges.some((e) => e.from === n.id || e.to === n.id))
      issues.push({ level: 'warning', nodeId: n.id, message: `"${n.name}" is not connected to anything.` });

    // Branch-label rules on outgoing links.
    const out = edges.filter((e) => e.from === n.id);
    const branch = outgoingLabels(n.type, n.config);
    if (branch.length) {
      for (const e of out.filter((x) => !x.label)) issues.push({ level: 'error', edgeId: `${e.from}->${e.to}`, nodeId: n.id, message: `"${n.name}": every outgoing link of a ${n.type} step needs a branch label.` });
      if (n.type === 'if') {
        if (!out.some((e) => e.label === 'true')) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}": missing the "true" branch.` });
        if (!out.some((e) => e.label === 'false')) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}": missing the "false" branch.` });
      }
      if (n.type === 'switch' && !out.some((e) => e.label === 'default')) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}": missing the "default" branch.` });
      if (n.type === 'loop' && !out.some((e) => e.label === 'each')) issues.push({ level: 'error', nodeId: n.id, message: `"${n.name}": missing the "each" branch (the loop body).` });
    } else {
      for (const e of out.filter((x) => x.label && x.label !== 'error')) issues.push({ level: 'error', edgeId: `${e.from}->${e.to}`, nodeId: n.id, message: `"${n.name}": only logic steps (if/switch/loop) have branch labels; use "on error" or none.` });
    }
  }
  // No nested loops.
  for (const n of nodes.filter((x) => x.type === 'loop'))
    for (const inner of loopBody(nodes, edges, n.id)) if (byId.get(inner)?.type === 'loop')
      issues.push({ level: 'error', nodeId: inner, message: `Nested loops are not supported ("${byId.get(inner)!.name}" is inside "${n.name}").` });
  return issues;
}

/** Layered auto-layout: topological depth left to right, order within a layer top to bottom. */
export function autoLayout(nodes: WfNode[], edges: WfEdge[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const e of edges) { const g = incoming.get(e.to) ?? []; g.push(e.from); incoming.set(e.to, g); }
  const compute = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length ? Math.max(...parents.map((p) => compute(p, seen))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) compute(n.id, new Set());
  const layers = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const i = layers.get(d) ?? 0;
    layers.set(d, i + 1);
    pos.set(n.id, { x: 40 + d * 280, y: 40 + i * 140 });
  }
  return pos;
}

export const categoryBadge = (category: StepCategory) => category;
