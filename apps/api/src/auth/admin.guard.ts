import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

/**
 * Dedicated capability for the SIMULATION endpoint only (decide as another identity / with caller-chosen attributes).
 * A valid user token alone is never enough. Disabled (403) unless IAM_API_ADMIN_TOKEN (16+ chars) is set. Local-demo secret, not a user identity.
 * With IAM_API_ADMIN_SUBJECTS (comma list of subjects) the verified caller must also be listed: the hosted edge attaches the secret to every call.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const want = process.env.IAM_API_ADMIN_TOKEN;
    if (!want || want.length < 16) throw new ForbiddenException('simulation is disabled (IAM_API_ADMIN_TOKEN not set)');
    const got = String(ctx.switchToHttp().getRequest().headers['x-api-admin-token'] ?? '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('admin capability required');
    // Hosted demo: the edge attaches the capability to EVERY proxied call, so the capability alone proves nothing about the caller.
    // When IAM_API_ADMIN_SUBJECTS is set, the verified token subject must also be one of the listed demo administrators (fail closed when no verified user).
    const subjects = (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (subjects.length) {
      const sub = ctx.switchToHttp().getRequest().user?.sub;
      if (typeof sub !== 'string' || !subjects.includes(sub)) throw new ForbiddenException('this account is not an administrator');
    }
    return true;
  }
}
