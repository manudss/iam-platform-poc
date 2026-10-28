import { BadGatewayException, Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CoreGrpc } from './core-grpc.js';
import { AuditService } from './audit.service.js';

interface CheckBody {
  tenant?: string;
  principal: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

/** Thin proxy: NestJS never decides, the Rust core does. Fails closed if the core is unreachable. */
@UseGuards(AuthGuard)
@Controller('access')
export class AccessController {
  constructor(private readonly audit: AuditService) {}
  private readonly core = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';

  private grpc?: CoreGrpc;

  /** Every answer (allow, deny, core unreachable) is written to the decision audit under the caller's token tenant. */
  @Post('check')
  async check(@Body() body: CheckBody, @Req() req: { user: { sub: string; tenant: string } }) {
    if (body.tenant !== undefined && body.tenant !== req.user.tenant) throw new ForbiddenException('wrong tenant');
    const tenant = body.tenant ?? req.user.tenant;
    const rec = (out: { allow: boolean; reasons?: string[]; errors?: string[]; version?: { seq: number; commit: string } }, source: 'http' | 'grpc', note?: string) =>
      this.audit.record({ tenant, subject: req.user.sub, principal: String(body.principal), action: String(body.action), resource: String(body.resource), allow: out.allow === true,
        reasons: [...(out.reasons ?? []), ...(out.errors ?? [])], activation_seq: out.version?.seq ?? null, commit: out.version?.commit ?? null, source, note });
    const g = process.env.IAM_CORE_GRPC_ADDR;
    if (g) {
      try { const out = await (this.grpc ??= new CoreGrpc(g)).decide(body); await rec(out, 'grpc'); return out; }
      catch { await rec({ allow: false, reasons: ['core-unreachable'] }, 'grpc', 'denied: core gRPC error'); throw new BadGatewayException({ allow: false, error: 'core gRPC error (denied)' }); }
    }
    let res: Response;
    try {
      res = await fetch(`${this.core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      await rec({ allow: false, reasons: ['core-unreachable'] }, 'http', 'denied: core unreachable');
      throw new BadGatewayException({ allow: false, error: 'core unreachable (denied)' });
    }
    if (!res.ok) { await rec({ allow: false, reasons: [`core-error-${res.status}`] }, 'http', 'denied: core error'); throw new BadGatewayException({ allow: false, error: `core error ${res.status} (denied)` }); }
    const out = (await res.json()) as { allow: boolean; reasons?: string[]; errors?: string[]; version?: { seq: number; commit: string } };
    await rec(out, 'http');
    return out;
  }
}
