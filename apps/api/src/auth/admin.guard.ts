import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { screenAccessOn, askScreen, screensFor } from './screen-decision.js';

/**
 * Dedicated capability for the SIMULATION endpoint only (decide as another identity / with caller-chosen attributes).
 * A valid user token alone is never enough. Disabled (403) unless IAM_API_ADMIN_TOKEN (16+ chars) is set. Local-demo secret, not a user identity.
 * With IAM_API_ADMIN_SUBJECTS (comma list of subjects) the verified caller must also be listed: the hosted edge attaches the secret to every call.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  /** The administrator capability alone (token, then the hosted subject list): the legacy rule, also the fallback before the first activation. */
  capability(ctx: ExecutionContext): boolean { return this.legacy(ctx, true); }
  private legacy(ctx: ExecutionContext, withSubjects: boolean): boolean {
    const want = process.env.IAM_API_ADMIN_TOKEN;
    if (!want || want.length < 16) throw new ForbiddenException('simulation is disabled (IAM_API_ADMIN_TOKEN not set)');
    const got = String(ctx.switchToHttp().getRequest().headers['x-api-admin-token'] ?? '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('admin capability required');
    if (!withSubjects) return true;
    // Hosted demo: the edge attaches the capability to EVERY proxied call, so the capability alone proves nothing about the caller.
    // When IAM_API_ADMIN_SUBJECTS is set, the verified token subject must also be one of the listed demo administrators (fail closed when no verified user).
    const subjects = (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (subjects.length) {
      const sub = ctx.switchToHttp().getRequest().user?.sub;
      if (typeof sub !== 'string' || !subjects.includes(sub)) throw new ForbiddenException('this account is not an administrator');
    }
    return true;
  }
  /** With IAM_SCREEN_ACCESS=1 the policy engine decides per screen (Cedar screen:open, roles of the active version); the hosted subject list no longer decides. */
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!screenAccessOn()) return this.legacy(ctx, true);
    this.legacy(ctx, false); // the capability the edge attaches stays required
    const req = ctx.switchToHttp().getRequest();
    const sub = req.user?.sub;
    if (typeof sub !== 'string' || !sub) throw new ForbiddenException('sign in required');
    const m = /\/tenants\/([^/]+)\/(.*)$/.exec(String(req.originalUrl ?? req.url ?? ''));
    const tenant = decodeURIComponent(m?.[1] ?? process.env.IAM_TENANT ?? 'acme-demo');
    const candidates = m ? screensFor(String(req.method ?? 'GET'), m[2]) : [];
    const tryScreens = candidates.length ? candidates : ['unmapped'];
    let engine = true;
    try {
      for (const sc of tryScreens) { const a = await askScreen(tenant, sub, sc); if (!a.engine) { engine = false; break; } if (a.allow) return true; }
    } catch (e) { throw new ForbiddenException(`the policy engine could not be reached (${(e as Error).message}); refused to stay on the safe side`); }
    if (!engine) return this.legacy(ctx, true); // before the first activation there is no policy yet
    throw new ForbiddenException({ code: 'screen-not-permitted', message: `You do not have access to ${candidates.length ? candidates.join(' / ') : 'this screen'}: ask an administrator for a role that opens it.`, screens: candidates });
  }
}

/** The policy-admin RIGHT (policy studio step 4): who may WRITE rules and template links (propose endpoints).
 *  Reads and simulations stay behind the administrator capability; writes additionally require the caller's subject in
 *  IAM_API_POLICY_ADMIN_SUBJECTS when that list is set (when unset, every administrator may write - the demo default). */
@Injectable()
export class PolicyAdminGuard extends AdminGuard {
  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await super.canActivate(ctx);
    const listed = (process.env.IAM_API_POLICY_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (listed.length) {
      const sub = ctx.switchToHttp().getRequest().user?.sub;
      if (typeof sub !== 'string' || !listed.includes(sub)) throw new ForbiddenException('the policy-admin right is required to change rules');
    }
    return true;
  }
}
