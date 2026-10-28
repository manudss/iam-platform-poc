import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Dedicated capability for the SIMULATION endpoint only (decide as another identity / with caller-chosen attributes).
 * A valid user token alone is never enough. Disabled (403) unless IAM_API_ADMIN_TOKEN (16+ chars) is set. Local-demo secret, not a user identity.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const want = process.env.IAM_API_ADMIN_TOKEN;
    if (!want || want.length < 16) throw new ForbiddenException('simulation is disabled (IAM_API_ADMIN_TOKEN not set)');
    const got = String(ctx.switchToHttp().getRequest().headers['x-api-admin-token'] ?? '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('admin capability required');
    return true;
  }
}
