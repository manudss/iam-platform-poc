/**
 * policy-studio plugin: a READ-ONLY catalogue of the Cedar rules the core decides with (relayed from the
 * Rust core over HTTP), the "why refused?" simulator, and rule/link proposals (one Dolt branch per change,
 * committed only when the core's dry-run build accepts it). All request validation, usage counting and the
 * proposal flow live in this folder; the core adapter only wires the dependencies (audit, Dolt, events)
 * and the controller.
 *
 * While the plugin is disabled on the branch, every /policies endpoint answers 404 and the Policies menu is hidden.
 *
 * deps = {
 *   pluginActive(tenant, id, ref) -> boolean
 *   auditList(tenant, max)        -> recent decision entries { reasons, allow, at }
 *   proposePolicyChange(change, validate) -> { branch, commit } (Dolt branch flow, core side)
 *   emit(type, tenant, branch, payload)   -> durable audit event
 *   env                           -> process.env-like ({ IAM_CORE_URL?, IAM_CORE_ADMIN_TOKEN? })
 * }
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException, NotFoundException, ServiceUnavailableException } = require('@nestjs/common');

export const POLICY_STUDIO_PLUGIN = 'policy-studio';
/** Decisions looked at to count rule usage: the most recent ones kept by the audit (its own maximum is 500). */
export const USAGE_WINDOW = 500;

/** The real source: the core over HTTP, with the core admin token. Not configured or not reachable = 503 (the screen says so; never an empty list). */
export function createCorePolicySource(env = process.env) {
  const conf = () => ({ url: env.IAM_CORE_URL, token: env.IAM_CORE_ADMIN_TOKEN });
  return {
    async catalog() {
      const { url, token } = conf();
      if (!url || !token) throw new ServiceUnavailableException('the rule catalogue needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
      let res;
      try { res = await fetch(`${url.replace(/\/$/, '')}/v1/policies`, { headers: { 'x-core-admin-token': token }, signal: AbortSignal.timeout(5000) }); }
      catch { throw new ServiceUnavailableException('the core is not reachable'); }
      if (!res.ok) throw new ServiceUnavailableException(`the core refused the catalogue (${res.status})`);
      const c = await res.json();
      if (!Array.isArray(c?.rules)) throw new ServiceUnavailableException('the core answered an unexpected catalogue');
      return c;
    },
    async validate(candidate) {
      const { url, token } = conf();
      if (!url || !token) throw new ServiceUnavailableException('rule validation needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
      let res;
      try {
        res = await fetch(`${url.replace(/\/$/, '')}/v1/policies/validate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': token }, body: JSON.stringify(candidate), signal: AbortSignal.timeout(5000) });
      } catch { throw new ServiceUnavailableException('the core is not reachable'); }
      if (res.status === 400) { const e = await res.json().catch(() => ({})); throw new BadRequestException(e.error ?? 'the core refused these rules'); }
      if (!res.ok) throw new ServiceUnavailableException(`the core refused the validation (${res.status})`);
      return await res.json();
    },
    async simulate(body) {
      const { url, token } = conf();
      if (!url || !token) throw new ServiceUnavailableException('the simulator needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
      let res;
      try {
        res = await fetch(`${url.replace(/\/$/, '')}/v1/policies/simulate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      } catch { throw new ServiceUnavailableException('the core is not reachable'); }
      if (res.status === 400) { const e = await res.json().catch(() => ({})); throw new BadRequestException(e.error ?? 'the core refused this simulation request'); }
      if (!res.ok) throw new ServiceUnavailableException(`the core refused the simulation (${res.status})`);
      return await res.json();
    },
  };
}

/** A simulation request is exactly what the core's decide takes: three entity ids and a free context. Never tenant data:
 *  exploring a context the tenant did not apply is the point of the simulator. */
export function checkSimulationRequest(b) {
  const r = b ?? {};
  const ok = (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 200;
  if (!ok(r.principal) || !ok(r.action) || !ok(r.resource)) throw new BadRequestException('principal, action and resource are required (e.g. User::"alice", Action::"approve", Request::"r1")');
  if (r.context !== undefined && (typeof r.context !== 'object' || r.context === null || Array.isArray(r.context))) throw new BadRequestException('context must be a JSON object');
  if (r.entities !== undefined && !Array.isArray(r.entities)) throw new BadRequestException('entities must be a JSON array');
  return { principal: r.principal.trim(), action: r.action.trim(), resource: r.resource.trim(), context: r.context, entities: r.entities };
}

/** Count, per rule id, the audited decisions whose reasons name it. Reasons that are not rule ids (core-unreachable, no-active-version...) simply match nothing. */
export function usageByRule(entries, ids) {
  const out = {};
  for (const e of entries) {
    for (const r of new Set(e.reasons)) {
      if (!ids.has(r)) continue;
      const u = (out[r] ??= { allow: 0, deny: 0, last_at: null });
      if (e.allow) u.allow++; else u.deny++;
      if (e.at && (!u.last_at || e.at > u.last_at)) u.last_at = e.at;
    }
  }
  return out;
}

/** A rule proposal: upsert (with its Cedar text) or delete one rule of one set. Ids stay small url-safe tokens. */
export function checkRuleProposal(b) {
  const r = b ?? {};
  if (r.op !== 'upsert' && r.op !== 'delete') throw new BadRequestException('op must be upsert or delete');
  if (typeof r.set !== 'string' || typeof r.id !== 'string') throw new BadRequestException('set and id are required');
  if (r.op === 'upsert') return { kind: 'upsert-rule', set: r.set, id: r.id, cedar: r.cedar };
  return { kind: 'delete-rule', set: r.set, id: r.id };
}
/** A link proposal: upsert (template + slot values) or delete one template link. */
export function checkLinkProposal(b) {
  const r = b ?? {};
  if (r.op !== 'upsert' && r.op !== 'delete') throw new BadRequestException('op must be upsert or delete');
  if (typeof r.id !== 'string') throw new BadRequestException('id is required');
  if (r.op === 'upsert') {
    if (typeof r.template !== 'string') throw new BadRequestException('template is required');
    return { kind: 'upsert-link', id: r.id, template: r.template, values: r.values ?? {} };
  }
  return { kind: 'delete-link', id: r.id };
}

/** The studio flow: catalogue + usage, simulator, and validated proposals on their own branch. */
export function createPolicyStudio(deps) {
  const need = async (t) => { if (!(await deps.pluginActive(t, POLICY_STUDIO_PLUGIN, 'work'))) throw new NotFoundException('the policy-studio plugin is not enabled'); };
  /** One rule or link change on a NEW Dolt branch, committed only when the core's dry-run build accepts the
   *  branch's whole rule set. Returns the branch, its commit and the validated catalogue preview. Merge stays an explicit act. */
  const propose = async (t, change) => {
    await need(t);
    let validation;
    const { branch, commit } = await deps.proposePolicyChange(change, async (cand) => { validation = await deps.source.validate(cand); });
    deps.emit('policy.changed', t, branch, { commit, operation: change.kind });
    return { branch, commit, valid: validation?.valid ?? true, schema: validation?.schema, engine: validation?.engine, catalogue: validation?.rules };
  };
  return {
    async catalog(t) {
      await need(t);
      const c = await deps.source.catalog();
      const entries = await deps.auditList(t, USAGE_WINDOW);
      return { ...c, usage: usageByRule(entries, new Set(c.rules.map((r) => r.id))), usage_window: { decisions: entries.length, max: USAGE_WINDOW } };
    },
    async simulate(t, body) {
      await need(t);
      return deps.source.simulate(checkSimulationRequest(body));
    },
    proposeRule: (t, body) => propose(t, checkRuleProposal(body)),
    proposeLink: (t, body) => propose(t, checkLinkProposal(body)),
  };
}

// No bus hooks: the plugin serves its flow through the engine the core adapter wires.
export default {};
