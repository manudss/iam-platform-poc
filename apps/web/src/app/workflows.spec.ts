import { signal } from '@angular/core';
import { Node } from 'ngx-vflow';
import { ApiClient } from './api';
import { SAMPLE_WORKFLOWS, STEP_TYPES, WorkflowClient, anchorViewport, leftmostNode, rectsWithin } from './workflows';

// Mirrors the server catalog (apps/api/src/workflows/model.ts WF_EVENTS): the editor fetches it live,
// the samples are checked against this copy so a drift between the two fails here.
const EVENT_PAYLOADS: Record<string, string[]> = {
  'user.created': ['subject', 'displayName', 'department', 'email'],
  'user.department-changed': ['subject', 'from', 'to'],
  'user.disabled': ['subject'],
  'signup.approved': ['subject', 'email'],
};

describe('workflow step types', () => {
  it('marks exactly wait/notify/fail as simulated; data steps are real', () => {
    const simulated = STEP_TYPES.filter((t) => t.simulated).map((t) => t.type);
    expect(simulated).toEqual(['wait', 'notify', 'fail']);
    const real = STEP_TYPES.filter((t) => !t.simulated).map((t) => t.type);
    expect(real).toEqual(['assign-role', 'revoke-role', 'set-department']);
  });
});

describe('sample workflows', () => {
  const topo = (nodes: { id: string }[], edges: { from: string; to: string }[]) => {
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const q = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
    let seen = 0;
    while (q.length) { const id = q.pop()!; seen++; for (const e of edges.filter((x) => x.from === id)) { const d = (indeg.get(e.to) ?? 1) - 1; indeg.set(e.to, d); if (d === 0) q.push(e.to); } }
    return seen;
  };
  it('use known types, unique ids and acyclic graphs with edges that reference real nodes', () => {
    const known = new Set(STEP_TYPES.map((t) => t.type));
    expect(SAMPLE_WORKFLOWS.length).toBeGreaterThanOrEqual(3);
    for (const s of SAMPLE_WORKFLOWS) {
      expect(s.name.startsWith('Sample: ')).toBe(true);
      const ids = s.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const n of s.nodes) { expect(known.has(n.type)).toBe(true); expect(n.name.length).toBeGreaterThan(0); }
      for (const e of s.edges) { expect(ids).toContain(e.from); expect(ids).toContain(e.to); }
      expect(topo(s.nodes, s.edges)).toBe(s.nodes.length); // no cycle
    }
  });
  it('triggered samples use a known event, valid match keys and placeholders that exist in the payload', () => {
    const triggered = SAMPLE_WORKFLOWS.filter((s) => s.trigger);
    expect(triggered.length).toBeGreaterThanOrEqual(3); // joiner / mover / leaver start by themselves
    for (const s of triggered) {
      const t = s.trigger!;
      const payload = EVENT_PAYLOADS[t.event];
      expect(payload, `unknown event ${t.event}`).toBeDefined();
      for (const k of Object.keys(t.match ?? {})) expect(payload).toContain(k);
      const keys = [...JSON.stringify(s.nodes).matchAll(/\{\{event\.([a-zA-Z]+)\}\}/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(payload, `${s.name}: {{event.${k}}}`).toContain(k);
    }
  });
  it('cover the demo story: onboarding, offboarding and a SoD case that fails then refuses the merge', () => {
    const names = SAMPLE_WORKFLOWS.map((s) => s.name).join(' ');
    expect(names).toContain('onboarding'); expect(names).toContain('offboarding'); expect(names).toContain('SoD');
  });
});


describe('initial canvas framing', () => {
  const node = (id: string, x: number, y: number) => ({ id, point: signal({ x, y }) }) as unknown as Node;
  it('anchors on the leftmost node near the top-left corner at reading zoom', () => {
    expect(anchorViewport([node('b', 300, 40), node('a', 40, 300)])).toEqual({ zoom: 0.9, x: 24 - 40 * 0.9, y: 24 - 300 * 0.9 });
  });
  it('picks the leftmost node and handles one or zero nodes', () => {
    expect(leftmostNode([node('b', 300, 40), node('a', 40, 300)])?.id).toBe('a');
    expect(leftmostNode([node('only', 5, 5)])?.id).toBe('only');
    expect(leftmostNode([])).toBeNull();
    expect(anchorViewport([])).toBeNull();
  });
  it('accepts fully visible nodes and rejects clipped or off-canvas ones (the load-framing defect)', () => {
    const canvas = { left: 0, top: 0, right: 800, bottom: 600 };
    expect(rectsWithin([{ left: 10, top: 10, right: 200, bottom: 120 }], canvas)).toBe(true);
    expect(rectsWithin([{ left: -40, top: 10, right: 200, bottom: 120 }], canvas)).toBe(false); // clipped left (mobile defect)
    expect(rectsWithin([{ left: 10, top: -20, right: 200, bottom: 120 }], canvas)).toBe(false); // clipped top
    expect(rectsWithin([{ left: 10, top: 10, right: 900, bottom: 120 }], canvas)).toBe(false); // beyond the right edge
    expect(rectsWithin([{ left: 10, top: 10, right: 200, bottom: 700 }], canvas)).toBe(false); // beyond the bottom edge
  });
});

describe('WorkflowClient', () => {
  const fakeFetch = (calls: { url: string; init: RequestInit }[], reply: object = {}) =>
    (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => reply } as Response; }) as unknown as typeof fetch;
  it('sends every call with the admin capability header and maps definitions/runs endpoints', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = new WorkflowClient(new ApiClient('acme-demo', fakeFetch(calls)), () => 'adm');
    await c.list(); await c.create('n', 'd', { nodes: [], edges: [] }, null);
    await c.runs(); await c.retry('r1'); await c.cancel('r1'); await c.review('r1');
    const h = (i: number) => (calls[i].init.headers as Record<string, string>)['x-api-admin-token'];
    expect(calls[0].url).toBe('/api/tenants/acme-demo/workflows'); expect(calls[0].init.method).toBe('GET');
    expect(calls[1].url).toBe('/api/tenants/acme-demo/workflows'); expect(calls[1].init.method).toBe('POST');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ name: 'n', description: 'd', graph: { nodes: [], edges: [] } });
    expect(calls[2].url).toBe('/api/tenants/acme-demo/workflow-runs');
    expect(calls[3].url).toBe('/api/tenants/acme-demo/workflow-runs/r1/retry');
    expect(calls[4].url).toBe('/api/tenants/acme-demo/workflow-runs/r1/cancel');
    expect(calls[5].url).toBe('/api/tenants/acme-demo/workflow-runs/r1/review');
    for (let i = 0; i < 6; i++) expect(h(i)).toBe('adm');
  });
  it('maps the event catalog and sends the trigger with the definition', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const c = new WorkflowClient(new ApiClient('acme-demo', fakeFetch(calls, { definition: { id: 'w1' } })), () => 'adm');
    await c.events();
    expect(calls[0].url).toBe('/api/tenants/acme-demo/workflows-events');
    const trigger = { event: 'user.created', match: { department: 'finance' } };
    await c.create('n', 'd', { nodes: [], edges: [] }, trigger);
    expect(JSON.parse(calls[1].init.body as string).trigger).toEqual(trigger);
    await c.update('w1', 'n', 'd', { nodes: [], edges: [] }, trigger);
    expect(JSON.parse(calls[2].init.body as string).trigger).toEqual(trigger);
  });
  it('surfaces the API error message', async () => {
    const fail = (async () => ({ ok: false, status: 403, json: async () => ({ message: 'admin only' }) }) as Response) as unknown as typeof fetch;
    const c = new WorkflowClient(new ApiClient('acme-demo', fail), () => 'x');
    await expect(c.list()).rejects.toThrow('admin only');
  });
});
