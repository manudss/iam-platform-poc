import { BadGatewayException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { CoreGrpc } from './core-grpc.js';

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
  private readonly core = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';

  private grpc?: CoreGrpc;
  /** gRPC to the core when IAM_CORE_GRPC_ADDR is set (host:port), otherwise HTTP JSON. Both fail closed. */
  @Post('check')
  async check(@Body() body: CheckBody) {
    const g = process.env.IAM_CORE_GRPC_ADDR;
    if (g) {
      try { return await (this.grpc ??= new CoreGrpc(g)).decide(body); }
      catch { throw new BadGatewayException({ allow: false, error: 'core gRPC error (denied)' }); }
    }
    let res: Response;
    try {
      res = await fetch(`${this.core}/v1/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new BadGatewayException({ allow: false, error: 'core unreachable (denied)' });
    }
    if (!res.ok) throw new BadGatewayException({ allow: false, error: `core error ${res.status} (denied)` });
    return res.json();
  }
}
