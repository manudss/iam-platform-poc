import { BadGatewayException, BadRequestException, Body, Controller, ForbiddenException, Headers, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuditService } from './audit.service.js';

/** Fixed, local tool registry of the bounded agent demo. Each tool maps to ONE Cedar action+resource. Results are simulated (no side effect anywhere). */
export const AGENT_TOOLS: Record<string, { action: string; resource: string; describe: string }> = {
  'read-report': { action: 'Action::"read"', resource: 'Report::"q3-demo"', describe: 'read a fictional report' },
  'approve-payment': { action: 'Action::"approve"', resource: 'Request::"r1"', describe: 'approve a fictional payment request' },
};
const MAX_TTL = 600, MAX_CALLS = 20;

interface Delegation { agent: string; sub: string; tenant: string; principal: string; tools: Set<string>; exp: number; left: number }
type DecideOut = { allow: boolean; reasons?: string[]; errors?: string[]; version?: { seq: number; commit: string } };

/**
 * Bounded agentic call demo. A user (valid IdP token) delegates a SCOPED tool allowlist to a named agent for a few minutes and a few calls.
 * The agent gets an opaque delegation secret (random, kept in memory only as a SHA-256 hash, never persisted, lost on restart; NOT a JWT).
 * Every call: allowlist check, then the SAME Cedar decision in the Rust core in TENANT mode with the delegating user's principal derived from the verified token (roles/SoD come from the active data version, no caller context).
 * Every call (allow, deny, outside allowlist, core down) is written to the decision audit with source 'agent'. The agent cannot create delegations
 * (that needs a user token) and cannot change principal, tenant or context. Not an autonomous agent: no planning, no tool beyond the registry.
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly audit: AuditService) {}
  private readonly core = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';
  private store = new Map<string, Delegation>();

  @UseGuards(AuthGuard)
  @Post('delegations')
  create(@Body() b: { agent_id?: string; principal?: string; tools?: string[]; ttl_seconds?: number; max_calls?: number }, @Req() req: { user: { sub: string; tenant: string } }) {
    if (!b.agent_id || typeof b.agent_id !== 'string' || b.agent_id.length > 64) throw new BadRequestException('agent_id required (max 64 chars)');
    const principal = `User::"${req.user.sub}"`; // the delegating user is the verified token subject, never a body field
    if (b.principal !== undefined && b.principal !== principal) throw new ForbiddenException('principal must be the authenticated subject');
    if ('context' in (b as object) || 'tenant_mode' in (b as object)) throw new BadRequestException('context and tenant_mode are not accepted: authorization attributes come from the core');
    if (!Array.isArray(b.tools) || b.tools.length === 0) throw new BadRequestException('tools allowlist required');
    const unknown = b.tools.filter((t) => !Object.hasOwn(AGENT_TOOLS, t));
    if (unknown.length) throw new BadRequestException(`unknown tools: ${unknown.join(',')}`);
    const ttl = Math.min(Math.max(Math.trunc(b.ttl_seconds ?? 300) || 300, 1), MAX_TTL);
    const calls = Math.min(Math.max(Math.trunc(b.max_calls ?? 5) || 5, 1), MAX_CALLS);
    const secret = randomBytes(32).toString('base64url');
    const exp = Date.now() + ttl * 1000;
    this.store.set(createHash('sha256').update(secret).digest('hex'), { agent: b.agent_id, sub: req.user.sub, tenant: req.user.tenant, principal, tools: new Set(b.tools), exp, left: calls });
    return { delegation: secret, agent_id: b.agent_id, tools: b.tools, max_calls: calls, expires_at: new Date(exp).toISOString() };
  }

  @Post('tools/call')
  async call(@Body() b: { tool?: string }, @Headers('x-agent-delegation') secret?: string) {
    if (!secret) throw new UnauthorizedException('missing delegation');
    const key = createHash('sha256').update(secret).digest('hex');
    const d = this.store.get(key);
    if (!d || d.exp <= Date.now()) { this.store.delete(key); throw new UnauthorizedException('unknown or expired delegation'); }
    const tool = typeof b?.tool === 'string' ? b.tool : '';
    const def = Object.hasOwn(AGENT_TOOLS, tool) ? AGENT_TOOLS[tool] : undefined;
    const rec = (out: DecideOut, note: string, answered = false) => this.audit.recordDecision({ tenant: d.tenant, subject: d.sub, principal: d.principal, action: def?.action ?? `Tool::"${tool.slice(0, 64)}"`, resource: def?.resource ?? '-',
      allow: out.allow === true, reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null, source: 'agent', note: `agent=${d.agent} tool=${tool.slice(0, 64)} ${note}` }, answered);
    if (!def || !d.tools.has(tool)) { await rec({ allow: false, reasons: ['tool-not-in-allowlist'] }, 'denied before the decision'); throw new ForbiddenException({ allow: false, error: 'tool not in the delegated allowlist' }); }
    if (d.left <= 0) { await rec({ allow: false, reasons: ['call-budget-exhausted'] }, 'denied before the decision'); throw new ForbiddenException({ allow: false, error: 'delegation call budget exhausted' }); }
    d.left--;
    let res: Response;
    try {
      res = await fetch(`${this.core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: d.tenant, principal: d.principal, action: def.action, resource: def.resource, context: {}, audit: { source: 'agent', subject: d.sub, note: `agent=${d.agent} tool=${tool.slice(0, 64)}` } }) });
    } catch { await rec({ allow: false, reasons: ['core-unreachable'] }, 'denied: core unreachable'); throw new BadGatewayException({ allow: false, error: 'core unreachable (denied)' }); }
    if (!res.ok) { await rec({ allow: false, reasons: [`core-error-${res.status}`] }, 'denied: core error'); throw new BadGatewayException({ allow: false, error: `core error ${res.status} (denied)` }); }
    const out = (await res.json()) as DecideOut;
    await rec(out, out.allow ? 'allowed' : 'denied by policy', true);
    if (!out.allow) throw new ForbiddenException({ allow: false, reasons: out.reasons ?? [], error: 'denied by policy' });
    return { allow: true, simulated: true, tool, output: `simulated result of "${def.describe}" (no real side effect)`, calls_left: d.left };
  }
}
