import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, UseGuards } from '@nestjs/common';
import { Optional } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { AuditService } from '../access/audit.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { PolicyAdminGuard } from '../auth/admin.guard.js';
import { DoltService, PolicyCandidate, PolicyChange } from '../dolt/dolt.service.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * Policy studio (plugin `policy-studio`). The catalogue/simulator/proposal logic lives in the plugin folder
 * (`plugins/policy-studio/handlers.mjs`); this file is the core adapter: it keeps the shared types, relays
 * the rule catalogue from the Rust core over HTTP (the plugin's source factory), wires the dependencies
 * (audit, Dolt branch flow, events) and exposes the admin controller.
 * While the plugin is disabled on the branch, every /policies endpoint answers 404 and the Policies menu is hidden.
 */

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

interface PolicyStudioPluginModule {
  POLICY_STUDIO_PLUGIN: string;
  USAGE_WINDOW: number;
  createCorePolicySource: (env?: NodeJS.ProcessEnv) => PolicySource;
  checkSimulationRequest: (b: unknown) => SimulationRequest;
  usageByRule: (entries: { reasons: string[]; allow: boolean; at?: string }[], ids: Set<string>) => Record<string, RuleUsage>;
  checkRuleProposal: (b: unknown) => PolicyChange;
  checkLinkProposal: (b: unknown) => PolicyChange;
  createPolicyStudio: (deps: {
    pluginActive: (tenant: string, id: string, ref: 'live' | 'work') => Promise<boolean>;
    auditList: (tenant: string, max: number) => Promise<{ reasons: string[]; allow: boolean; at?: string }[]>;
    proposePolicyChange: (change: PolicyChange, validate: (cand: PolicyCandidate) => Promise<void>) => Promise<{ branch: string; commit: string }>;
    emit: (type: string, tenant: string, branch: string, payload: Record<string, string>) => void;
    source: PolicySource;
  }) => {
    catalog: (t: string) => Promise<CoreCatalog & { usage: Record<string, RuleUsage>; usage_window: { decisions: number; max: number } }>;
    simulate: (t: string, body: unknown) => Promise<SimulationResult>;
    proposeRule: (t: string, body: unknown) => Promise<unknown>;
    proposeLink: (t: string, body: unknown) => Promise<unknown>;
  };
}
const plugin = loadPluginModule('policy-studio', 'handlers.mjs') as PolicyStudioPluginModule;

export const POLICY_STUDIO_PLUGIN = plugin.POLICY_STUDIO_PLUGIN;
/** Decisions looked at to count rule usage: the most recent ones kept by the audit (its own maximum is 500). */
export const USAGE_WINDOW = plugin.USAGE_WINDOW;
export const checkSimulationRequest = plugin.checkSimulationRequest;
export const usageByRule = plugin.usageByRule;
export const checkRuleProposal = plugin.checkRuleProposal;
export const checkLinkProposal = plugin.checkLinkProposal;

/** The real source: the core over HTTP, with the core admin token. Not configured or not reachable = 503 (the screen says so; never an empty list). */
@Injectable()
export class CorePolicySource implements PolicySource {
  private readonly inner = plugin.createCorePolicySource(process.env);
  catalog() { return this.inner.catalog(); }
  validate(candidate: PolicyCandidate) { return this.inner.validate(candidate); }
  simulate(body: SimulationRequest) { return this.inner.simulate(body); }
}

@Injectable()
export class PolicyStudioService {
  private readonly studio: ReturnType<PolicyStudioPluginModule['createPolicyStudio']>;
  constructor(profile: ProfileService, @Inject(POLICY_SOURCE) source: PolicySource, audit: AuditService, dolt: DoltService, @Optional() events?: ApplicationBus) {
    this.studio = plugin.createPolicyStudio({
      pluginActive: (t, id, ref) => profile.pluginActive(t, id, ref),
      auditList: (t, max) => audit.list(t, max),
      proposePolicyChange: async (change, validate) => { const r = await dolt.proposePolicyChange(change, validate); return { branch: r.branch, commit: r.commit }; },
      emit: (type, tenant, branch, payload) => events?.emit({ type, tenant, branch, at: new Date().toISOString(), payload }),
      source,
    });
  }
  catalog(t: string) { return this.studio.catalog(t); }
  simulate(t: string, body: unknown) { return this.studio.simulate(t, body); }
  proposeRule(t: string, body: unknown) { return this.studio.proposeRule(t, body); }
  proposeLink(t: string, body: unknown) { return this.studio.proposeLink(t, body); }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/policies')
export class PolicyStudioController {
  constructor(private readonly s: PolicyStudioService) {}
  @Get() list(@Param('tenant') t: string) { return this.s.catalog(t); }
  @Post('simulate') @HttpCode(200) simulate(@Param('tenant') t: string, @Body() body: unknown) { return this.s.simulate(t, body); } // a query, not a creation
  // Writes: the policy-admin RIGHT, not only the administrator capability. Each proposal is one branch, validated pre-commit.
  @Post('rules/propose') @UseGuards(PolicyAdminGuard) proposeRule(@Param('tenant') t: string, @Body() body: unknown) { return this.s.proposeRule(t, body); }
  @Post('links/propose') @UseGuards(PolicyAdminGuard) proposeLink(@Param('tenant') t: string, @Body() body: unknown) { return this.s.proposeLink(t, body); }
}
