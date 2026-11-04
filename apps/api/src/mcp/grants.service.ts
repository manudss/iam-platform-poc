import { Injectable } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';

/**
 * Delegation grants (MCP gateway P2): which identity may invoke which tool of which relayed upstream.
 * The table lives in the VERSIONED business database (created lazily on the working branch of whoever
 * writes first, seeded by data/demo/01-schema.sql on fresh demos): a grant written on a branch has NO
 * effect until a human merges it into main and the resulting commit is ACTIVATED - exactly like roles.
 *
 * Enforcement is server-side at two levels, always from the ACTIVE version (never from a branch):
 *  - tools/list only shows relayed tools the session owner's active grants cover (this service);
 *  - every relayed tools/call is re-authorized by Cedar: the core injects the same active grants into
 *    context.mcp_grants and the mcp:proxy policy requires the exact UpstreamTool to be listed.
 */

export interface GrantRow { tenant: string; identity: string; upstream: string; tool: string; expiresAt: string | null; grantedBy: string }

/** Versioned DDL (working branch of the writer; fresh demos get it from the seed). */
export const GRANTS_DDL = `CREATE TABLE IF NOT EXISTS delegation_grants (
  tenant VARCHAR(32) NOT NULL, identity_id VARCHAR(64) NOT NULL, upstream VARCHAR(40) NOT NULL, tool VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NULL, granted_by VARCHAR(64) NOT NULL, PRIMARY KEY (tenant, identity_id, upstream, tool))`;

const COMMIT = /^[0-9a-v]{8,64}$/;
type Row = Record<string, unknown>;

@Injectable()
export class McpGrantsService {
  constructor(private readonly v: VersioningService) {}
  private get core() { return process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081'; }

  /** The commit the policy engine currently enforces for the tenant, or null when nothing is active yet. */
  private async activeCommit(tenant: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.core}/v1/version?tenant=${encodeURIComponent(tenant)}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const commit = String(((await res.json()) as { commit?: string }).commit ?? '');
      return COMMIT.test(commit) ? commit : null;
    } catch { return null; } // core unreachable: fail closed (no relayed tool shown)
  }

  /** Grant rows of the ACTIVE version. Empty without an active version or on pre-P2 databases. */
  async atActiveCommit(tenant: string): Promise<{ commit: string | null; grants: GrantRow[] }> {
    const commit = await this.activeCommit(tenant);
    if (!commit) return { commit: null, grants: [] };
    const grants = await this.v.at(this.v.defaultBranch, async (c) => {
      try {
        const [r] = await c.query(
          `select identity_id, upstream, tool, cast(expires_at as char) expires_at, granted_by from delegation_grants as of '${commit}' where tenant = ? order by 1,2,3 limit 5000`, [tenant]);
        return (r as Row[]).map((x) => ({
          tenant, identity: String(x.identity_id), upstream: String(x.upstream), tool: String(x.tool),
          expiresAt: x.expires_at === null ? null : new Date(`${String(x.expires_at).replace(' ', 'T')}Z`).toISOString(),
          grantedBy: String(x.granted_by),
        }));
      } catch { return [] as GrantRow[]; } // no delegation_grants table on this database
    });
    return { commit, grants };
  }

  /** The "<upstream>__<tool>" names one identity may invoke right now (unexpired grants of the ACTIVE version). */
  async allowedTools(tenant: string, identity: string): Promise<Set<string>> {
    const { grants } = await this.atActiveCommit(tenant);
    const now = Date.now();
    return new Set(grants.filter((g) => g.identity === identity && (!g.expiresAt || Date.parse(g.expiresAt) > now)).map((g) => `${g.upstream}__${g.tool}`));
  }
}
