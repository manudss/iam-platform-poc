import { BadGatewayException, Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CoreGrpc } from './core-grpc.js';
import { AuditService } from './audit.service.js';

interface CheckBody {
  tenant?: string;
  principal?: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}
type Out = { allow: boolean; reasons?: string[]; errors?: string[]; version?: { seq: number; commit: string } };

/** Attributes that influence authorization and therefore must come from a server source (the ACTIVE data version in the core), never from a caller. */
export const TRUSTED_ONLY_KEYS = ['roles', 'sod_conflict', 'tenant_mode'];
export function untrustedContext(c: unknown): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (c && typeof c === 'object' && !Array.isArray(c)) for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (!TRUSTED_ONLY_KEYS.includes(k)) o[k] = v;
  return o;
}

/**
 * Thin proxy: NestJS never decides, the Rust core does. Fails closed if the core is unreachable.
 * Authority boundary: subject and tenant come from the VERIFIED token. /access/check always runs in tenant mode as the caller
 * (principal User::"<sub>"); a different principal or tenant in the body is 403; roles/sod_conflict/tenant_mode from the body are dropped
 * (the core computes them from the active data version). Deciding as someone else is only possible on /access/simulate (separate admin capability).
 */
@UseGuards(AuthGuard)
@Controller('access')
export class AccessController {
  constructor(private readonly audit: AuditService) {}
  private readonly core = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';
  private grpc?: CoreGrpc;

  private async run(req: { tenant?: string; principal: string; action: string; resource: string; context: Record<string, unknown> }, rec: (o: Out, s: 'http' | 'grpc' | 'simulate', n?: string, answered?: boolean) => Promise<void>, simulate: boolean, meta?: { source: string; note?: string; subject: string }): Promise<Out> {
    const g = process.env.IAM_CORE_GRPC_ADDR;
    if (g && !simulate) {
      try { const out = await (this.grpc ??= new CoreGrpc(g)).decide(req); await rec(out, 'grpc'); return out; } // grpc carries no audit meta: the core emits access.decided without it (row source 'core')
      catch { await rec({ allow: false, reasons: ['core-unreachable'] }, 'grpc', 'denied: core gRPC error', false); throw new BadGatewayException({ allow: false, error: 'core gRPC error (denied)' }); }
    }
    const s = simulate ? 'simulate' : 'http';
    let res: Response;
    try {
      // Step 3: the caller audit meta rides in the body; the core stamps it on the access.decided bus event.
      res = await fetch(`${this.core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...req, ...(meta ? { audit: meta } : {}) }) });
    } catch {
      await rec({ allow: false, reasons: ['core-unreachable'] }, s, 'denied: core unreachable', false);
      throw new BadGatewayException({ allow: false, error: 'core unreachable (denied)' });
    }
    if (!res.ok) { await rec({ allow: false, reasons: [`core-error-${res.status}`] }, s, 'denied: core error', false); throw new BadGatewayException({ allow: false, error: `core error ${res.status} (denied)` }); }
    const out = (await res.json()) as Out;
    await rec(out, s);
    return out;
  }

  /** Every answer (allow, deny, core unreachable) is written to the decision audit under the caller's token tenant. */
  @Post('check')
  async check(@Body() body: CheckBody, @Req() req: { user: { sub: string; tenant: string } }) {
    const principal = `User::"${req.user.sub}"`;
    if (body.tenant !== undefined && body.tenant !== req.user.tenant) throw new ForbiddenException('wrong tenant');
    if (body.principal !== undefined && body.principal !== principal) throw new ForbiddenException('principal must be the authenticated subject');
    const tenant = req.user.tenant;
    const rec = (out: Out, source: 'http' | 'grpc' | 'simulate', note?: string, answered?: boolean) =>
      this.audit.recordDecision({ tenant, subject: req.user.sub, principal, action: String(body.action), resource: String(body.resource), allow: out.allow === true,
        reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null, source, note }, answered);
    return this.run({ tenant, principal, action: String(body.action), resource: String(body.resource), context: untrustedContext(body.context) }, rec, false, { source: 'http', subject: req.user.sub });
  }

  /**
   * SIMULATION (what-if), explicitly separate: needs a valid token AND the admin capability header. Decides as the principal and with the
   * attributes given in the body, in demo mode (no tenant data) unless `tenant` is given. It never runs a tool and its audit rows have source 'simulate'.
   */
  @UseGuards(AdminGuard)
  @Post('simulate')
  async simulate(@Body() body: CheckBody, @Req() req: { user: { sub: string; tenant: string } }) {
    if (body.tenant !== undefined && body.tenant !== req.user.tenant) throw new ForbiddenException('wrong tenant');
    const tenant = req.user.tenant, principal = String(body.principal ?? '');
    const rec = (out: Out, source: 'http' | 'grpc' | 'simulate', note?: string, answered?: boolean) =>
      this.audit.recordDecision({ tenant, subject: req.user.sub, principal, action: String(body.action), resource: String(body.resource), allow: out.allow === true,
        reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null, source, note: note ?? 'simulation (admin capability)' }, answered);
    return this.run({ ...(body.tenant !== undefined ? { tenant } : {}), principal, action: String(body.action), resource: String(body.resource), context: body.context ?? {} }, rec, true, { source: 'simulate', subject: req.user.sub, note: 'simulation (admin capability)' });
  }
}
