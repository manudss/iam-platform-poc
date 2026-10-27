import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createPublicKey, verify, KeyObject } from 'node:crypto';

interface Claims { iss: string; aud: string; sub: string; exp: number; tenant: string }

/**
 * Verifies the bearer token issued by the core IdP prototype: EdDSA signature (key from the core JWKS),
 * issuer, audience and expiry. If the route has a :tenant param, the tenant claim must match it.
 * There is no bypass switch. (Tests override the guard explicitly through Nest's testing API.)
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private keys = new Map<string, KeyObject>();

  private get coreUrl() { return process.env.IAM_CORE_URL ?? 'http://127.0.0.1:8081'; }
  private get issuer() { return process.env.IAM_ISSUER ?? this.coreUrl; }
  private get audience() { return process.env.IAM_AUDIENCE ?? 'demo-web'; }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const ck = `${this.coreUrl}|${kid}`;
    if (!this.keys.has(ck)) {
      try {
        const jwks = (await (await fetch(`${this.coreUrl}/jwks.json`)).json()) as { keys: { kid: string; x: string }[] };
        for (const k of jwks.keys) this.keys.set(`${this.coreUrl}|${k.kid}`, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' }));
      } catch { /* core unreachable: no key, token rejected (fail closed) */ }
    }
    return this.keys.get(ck);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers['authorization'];
    if (!h?.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');
    const parts = h.slice(7).split('.');
    if (parts.length !== 3) throw new UnauthorizedException('malformed token');
    let header: { alg?: string; kid?: string };
    let claims: Claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch { throw new UnauthorizedException('malformed token'); }
    if (header.alg !== 'EdDSA' || !header.kid) throw new UnauthorizedException('unsupported algorithm');
    const key = await this.key(header.kid);
    if (!key || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url')))
      throw new UnauthorizedException('bad signature');
    if (claims.iss !== this.issuer) throw new UnauthorizedException('bad issuer');
    if (claims.aud !== this.audience) throw new UnauthorizedException('bad audience');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new UnauthorizedException('token expired');
    const tenant = req.params?.tenant;
    if (tenant !== undefined && tenant !== claims.tenant) throw new ForbiddenException('wrong tenant');
    req.user = claims;
    return true;
  }
}
