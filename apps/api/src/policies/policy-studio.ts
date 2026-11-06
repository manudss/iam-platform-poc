import { Controller, Get, Inject, Injectable, NotFoundException, Param, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuditService } from '../access/audit.service.js';
import { ProfileService } from '../profile/profile.service.js';

/**
 * Policy studio (plugin `policy-studio`), step 1: a READ-ONLY catalogue of the Cedar rules the core decides with, and how often
 * recent decisions in the audit named each rule. Nothing here changes a rule or a decision. The rules live in the Rust core (policies/*.cedar
 * loaded at startup); the core serves the list on GET /v1/policies with its admin token, this service only relays it.
 * While the plugin is disabled on the branch, every /policies endpoint answers 404 and the Policies menu is hidden.
 */
export const POLICY_STUDIO_PLUGIN = 'policy-studio';
/** Decisions looked at to count rule usage: the most recent ones kept by the audit (its own maximum is 500). */
export const USAGE_WINDOW = 500;

export interface RuleInfo {
  id: string; set: string; name: string; kind: 'policy' | 'template'; effect: 'permit' | 'forbid';
  description: string | null; pillar: string | null; summary: string; conditions: number; annotations: Record<string, string>; text: string;
}
export interface CoreCatalog { engine: { rules: number; sets: number; schema?: boolean }; sets: { name: string; rules: number }[]; rules: RuleInfo[] }
export interface RuleUsage { allow: number; deny: number; last_at: string | null }

export interface PolicySource { catalog(): Promise<CoreCatalog> }
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

@Injectable()
export class PolicyStudioService {
  constructor(private readonly profile: ProfileService, @Inject(POLICY_SOURCE) private readonly source: PolicySource, private readonly audit: AuditService) {}
  private async need(t: string) { if (!(await this.profile.pluginActive(t, POLICY_STUDIO_PLUGIN, 'work'))) throw new NotFoundException('the policy-studio plugin is not enabled'); }
  async catalog(t: string) {
    await this.need(t);
    const c = await this.source.catalog();
    const entries = await this.audit.list(t, USAGE_WINDOW);
    return { ...c, usage: usageByRule(entries, new Set(c.rules.map((r) => r.id))), usage_window: { decisions: entries.length, max: USAGE_WINDOW } };
  }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/policies')
export class PolicyStudioController {
  constructor(private readonly s: PolicyStudioService) {}
  @Get() list(@Param('tenant') t: string) { return this.s.catalog(t); }
}
