import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { Optional } from '@nestjs/common';
import { ApplicationBus } from '../events/application-bus.service.js';
import { AuditService } from '../access/audit.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { PolicyAdminGuard } from '../auth/admin.guard.js';
import { DoltService, PolicyCandidate, PolicyChange } from '../dolt/dolt.service.js';

/**
 * Policy studio (plugin `policy-studio`). Step 1: a READ-ONLY catalogue of the Cedar rules the core decides with, and how often
 * recent decisions in the audit named each rule. Step 3: the simulator POST .../policies/simulate answers "why refused?" for a request
 * the administrator types (person, action, resource, context) - the core evaluates it against the loaded rules and explains the outcome.
 * Nothing here changes a rule or a decision. The rules live in the Rust core (policies/*.cedar
 * loaded at startup); the core serves the list on GET /v1/policies with its admin token, this service only relays it.
 * While the plugin is disabled on the branch, every /policies endpoint answers 404 and the Policies menu is hidden.
 */
export const POLICY_STUDIO_PLUGIN = 'policy-studio';
/** Decisions looked at to count rule usage: the most recent ones kept by the audit (its own maximum is 500). */
export const USAGE_WINDOW = 500;

export interface RuleInfo {
  id: string; set: string; name: string; kind: 'policy' | 'template' | 'link'; effect: 'permit' | 'forbid';
  description: string | null; pillar: string | null; summary: string; conditions: number; annotations: Record<string, string>; text: string;
  template?: string; values?: Record<string, string>; // a link: the template it instantiates and its slot values (the beneficiary)
}
export interface CoreCatalog { engine: { rules: number; sets: number; schema?: boolean }; sets: { name: string; rules: number }[]; rules: RuleInfo[] }
export interface RuleUsage { allow: number; deny: number; last_at: string | null }

export interface SimulationRequest { principal: string; action: string; resource: string; context?: Record<string, unknown>; entities?: unknown[] }
export interface SimulationResult {
  allow: boolean; reasons: string[]; errors: string[]; matched_permits: string[]; matched_forbids: string[];
  errored_rules: { id: string; error: string }[]; templates: string[]; explanation: string;
}

export interface PolicyValidation { valid: boolean; schema?: boolean; engine?: { rules: number; sets: number }; rules?: RuleInfo[] }
export interface PolicySource { catalog(): Promise<CoreCatalog>; simulate(body: SimulationRequest): Promise<SimulationResult>; validate(candidate: PolicyCandidate): Promise<PolicyValidation> }
export const POLICY_SOURCE = Symbol('POLICY_SOURCE');

/** The real source: the core over HTTP, with the core admin token. Not configured or not reachable = 503 (the screen says so; never an empty list). */
@Injectable()
export class CorePolicySource implements PolicySource {
  async catalog(): Promise<CoreCatalog> {
    const url = process.env.IAM_CORE_URL, token = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url || !token) throw new ServiceUnavailableException('the rule catalogue needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
    let res: Response;
    try { res = await fetch(`${url.replace(/\/$/, '')}/v1/policies`, { headers: { 'x-core-admin-token': token }, signal: AbortSignal.timeout(5000) }); }
    catch { throw new ServiceUnavailableException('the core is not reachable'); }
    if (!res.ok) throw new ServiceUnavailableException(`the core refused the catalogue (${res.status})`);
    const c = (await res.json()) as CoreCatalog;
    if (!Array.isArray(c?.rules)) throw new ServiceUnavailableException('the core answered an unexpected catalogue');
    return c;
  }
  async validate(candidate: PolicyCandidate): Promise<PolicyValidation> {
    const url = process.env.IAM_CORE_URL, token = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url || !token) throw new ServiceUnavailableException('rule validation needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/policies/validate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': token }, body: JSON.stringify(candidate), signal: AbortSignal.timeout(5000) });
    } catch { throw new ServiceUnavailableException('the core is not reachable'); }
    if (res.status === 400) { const e = (await res.json().catch(() => ({}))) as { error?: string }; throw new BadRequestException(e.error ?? 'the core refused these rules'); }
    if (!res.ok) throw new ServiceUnavailableException(`the core refused the validation (${res.status})`);
    return (await res.json()) as PolicyValidation;
  }
  async simulate(body: SimulationRequest): Promise<SimulationResult> {
    const url = process.env.IAM_CORE_URL, token = process.env.IAM_CORE_ADMIN_TOKEN;
    if (!url || !token) throw new ServiceUnavailableException('the simulator needs IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN');
    let res: Response;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/policies/simulate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    } catch { throw new ServiceUnavailableException('the core is not reachable'); }
    if (res.status === 400) { const e = (await res.json().catch(() => ({}))) as { error?: string }; throw new BadRequestException(e.error ?? 'the core refused this simulation request'); }
    if (!res.ok) throw new ServiceUnavailableException(`the core refused the simulation (${res.status})`);
    return (await res.json()) as SimulationResult;
  }
}

/** A simulation request is exactly what the core's decide takes: three entity ids and a free context. Never tenant data:
 *  exploring a context the tenant did not apply is the point of the simulator. */
export function checkSimulationRequest(b: unknown): SimulationRequest {
  const r = b as Partial<SimulationRequest>;
  const ok = (x: unknown) => typeof x === 'string' && x.trim().length > 0 && x.length <= 200;
  if (!r || !ok(r.principal) || !ok(r.action) || !ok(r.resource)) throw new BadRequestException('principal, action and resource are required (e.g. User::"alice", Action::"approve", Request::"r1")');
  if (r.context !== undefined && (typeof r.context !== 'object' || r.context === null || Array.isArray(r.context))) throw new BadRequestException('context must be a JSON object');
  if (r.entities !== undefined && !Array.isArray(r.entities)) throw new BadRequestException('entities must be a JSON array');
  return { principal: r.principal!.trim(), action: r.action!.trim(), resource: r.resource!.trim(), context: r.context, entities: r.entities };
}

/** Count, per rule id, the audited decisions whose reasons name it. Reasons that are not rule ids (core-unreachable, no-active-version...) simply match nothing. */
export function usageByRule(entries: { reasons: string[]; allow: boolean; at?: string }[], ids: Set<string>): Record<string, RuleUsage> {
  const out: Record<string, RuleUsage> = {};
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
export function checkRuleProposal(b: unknown): PolicyChange {
  const r = b as { op?: string; set?: string; id?: string; cedar?: string };
  if (!r || (r.op !== 'upsert' && r.op !== 'delete')) throw new BadRequestException('op must be upsert or delete');
  if (typeof r.set !== 'string' || typeof r.id !== 'string') throw new BadRequestException('set and id are required');
  if (r.op === 'upsert') return { kind: 'upsert-rule', set: r.set, id: r.id, cedar: r.cedar as string };
  return { kind: 'delete-rule', set: r.set, id: r.id };
}
/** A link proposal: upsert (template + slot values) or delete one template link. */
export function checkLinkProposal(b: unknown): PolicyChange {
  const r = b as { op?: string; id?: string; template?: string; values?: Record<string, string> };
  if (!r || (r.op !== 'upsert' && r.op !== 'delete')) throw new BadRequestException('op must be upsert or delete');
  if (typeof r.id !== 'string') throw new BadRequestException('id is required');
  if (r.op === 'upsert') {
    if (typeof r.template !== 'string') throw new BadRequestException('template is required');
    return { kind: 'upsert-link', id: r.id, template: r.template, values: r.values ?? {} };
  }
  return { kind: 'delete-link', id: r.id };
}

@Injectable()
export class PolicyStudioService {
  constructor(private readonly profile: ProfileService, @Inject(POLICY_SOURCE) private readonly source: PolicySource, private readonly audit: AuditService, private readonly dolt: DoltService, @Optional() private readonly events?: ApplicationBus) {}
  private async need(t: string) { if (!(await this.profile.pluginActive(t, POLICY_STUDIO_PLUGIN, 'work'))) throw new NotFoundException('the policy-studio plugin is not enabled'); }
  async catalog(t: string) {
    await this.need(t);
    const c = await this.source.catalog();
    const entries = await this.audit.list(t, USAGE_WINDOW);
    return { ...c, usage: usageByRule(entries, new Set(c.rules.map((r) => r.id))), usage_window: { decisions: entries.length, max: USAGE_WINDOW } };
  }
  async simulate(t: string, body: unknown) {
    await this.need(t);
    return this.source.simulate(checkSimulationRequest(body));
  }
  /** Step 4: one rule or link change on a NEW Dolt branch, committed only when the core's dry-run build accepts the
   *  branch's whole rule set. Returns the branch, its commit and the validated catalogue preview. Merge stays an explicit act. */
  private async propose(t: string, change: PolicyChange) {
    await this.need(t);
    let validation: PolicyValidation | undefined;
    const { branch, commit } = await this.dolt.proposePolicyChange(change, async (cand) => { validation = await this.source.validate(cand); });
    this.events?.emit({ type: 'policy.changed', tenant: t, branch, at: new Date().toISOString(), payload: { commit, operation: change.kind } });
    return { branch, commit, valid: validation?.valid ?? true, schema: validation?.schema, engine: validation?.engine, catalogue: validation?.rules };
  }
  async proposeRule(t: string, body: unknown) { return this.propose(t, checkRuleProposal(body)); }
  async proposeLink(t: string, body: unknown) { return this.propose(t, checkLinkProposal(body)); }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/policies')
export class PolicyStudioController {
  constructor(private readonly s: PolicyStudioService) {}
  @Get() list(@Param('tenant') t: string) { return this.s.catalog(t); }
  @Post('simulate') @HttpCode(200) simulate(@Param('tenant') t: string, @Body() body: unknown) { return this.s.simulate(t, body); } // a query, not a creation
  // Writes (step 4): the policy-admin RIGHT, not only the administrator capability. Each proposal is one branch, validated pre-commit.
  @Post('rules/propose') @UseGuards(PolicyAdminGuard) proposeRule(@Param('tenant') t: string, @Body() body: unknown) { return this.s.proposeRule(t, body); }
  @Post('links/propose') @UseGuards(PolicyAdminGuard) proposeLink(@Param('tenant') t: string, @Body() body: unknown) { return this.s.proposeLink(t, body); }
}
