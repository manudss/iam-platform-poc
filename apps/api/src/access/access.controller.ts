import { BadGatewayException, Body, Controller, Post } from '@nestjs/common';

interface CheckBody {
  principal: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

/** Thin proxy: NestJS never decides, the Rust core does. Fails closed if the core is unreachable. */
@Controller('access')
export class AccessController {
  private readonly core = process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081';

  @Post('check')
  async check(@Body() body: CheckBody) {
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
