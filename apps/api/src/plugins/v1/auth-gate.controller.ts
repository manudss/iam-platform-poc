import { Optional } from '@nestjs/common';
import { AuthnService } from '../../authn/flow.service.js';
import { BranchRegistries } from './branch-registries.js';
import { workspaceMode } from '../../workspace/context.js';
import { Body, Controller, Headers, HttpCode, HttpException, NotFoundException, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PluginRegistry } from './registry.js';
import type { AuthenticateResult } from './hooks.js';

/**
 * Sign-in gate called by the Rust core (loopback, shared token IAM_AUTH_GATE_TOKEN) before the IdP checks a password.
 * - allow / deny / challenge are BUSINESS answers: HTTP 200. A wrong password or a lockout is a deny; it never faults the plugin.
 * - a technical failure (plugin threw, timed out, faulted) answers 503: the core refuses the sign-in too (fail closed).
 *   The base plugin is never asked after a replacement failed.
 * The endpoint does not exist (404) unless the token is configured. A 'challenge' is not supported by the demo form and counts as a deny.
 */
@Controller('internal/auth')
export class AuthGateController {
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches: BranchRegistries, @Optional() private readonly authn?: AuthnService) {}
  private gate(tok: string | undefined) {
    const want = process.env.IAM_AUTH_GATE_TOKEN;
    if (!want || want.length < 8) throw new NotFoundException();
    const a = Buffer.from(tok ?? ''), w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w)) throw new HttpException({ outcome: 'error', code: 'bad-gate-token' }, 401);
  }

  /** First page of the sign-in form: which inputs sit next to the user name. `legacy` = no chain is live, the classic user + password form. */
  @Post('entry') @HttpCode(200)
  async entry(@Headers('x-gate-token') tok: string | undefined, @Body() b: { tenant?: string }) {
    this.gate(tok);
    if (!this.authn || typeof b?.tenant !== 'string') return { mode: 'legacy' };
    try { return await this.authn.entry(b.tenant); } catch { throw new HttpException({ outcome: 'error', code: 'plugin-failed' }, 503); }
  }

  @Post('authenticate') @HttpCode(200)
  async authenticate(@Headers('x-gate-token') tok: string | undefined, @Body() b: { tenant?: string; subject?: string; password?: string; session?: string; answers?: Record<string, string> }) {
    const want = process.env.IAM_AUTH_GATE_TOKEN;
    if (!want || want.length < 8) throw new NotFoundException();
    const a = Buffer.from(tok ?? ''), w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w)) throw new HttpException({ outcome: 'error', code: 'bad-gate-token' }, 401);
    if (this.authn && typeof b?.tenant === 'string' && (typeof b.session === 'string' || typeof b.subject === 'string')) {
      // Chain mode: the control plane runs the steps (a bare password is the first step's answer when that step is a password). null = no chain is live, fall through to the base password path.
      try {
        const r = await this.authn.authenticate({ tenant: b.tenant, subject: b.subject, session: b.session, answers: b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : typeof b.password === 'string' ? { password: b.password } : undefined });
        if (r) return r;
      } catch (e) { throw new HttpException({ outcome: 'error', code: (e as { code?: string }).code ?? 'plugin-failed' }, 503); }
    }
    if (typeof b?.tenant !== 'string' || typeof b.subject !== 'string' || typeof b.password !== 'string') throw new HttpException({ outcome: 'error', code: 'bad-request' }, 400);
    try {
      const registry = workspaceMode() ? await this.branches.get('main') : this.reg;
      const r = await registry.callSlot<AuthenticateResult>(b.tenant, 'auth.password', 'auth.authenticate', { tenant: b.tenant, subject: b.subject, credential: { password: b.password } });
      return r.result.outcome === 'allow' ? { outcome: 'allow', servedBy: r.servedBy } : { outcome: 'deny', reason: r.result.outcome === 'deny' ? r.result.reason : 'challenge-unsupported', servedBy: r.servedBy };
    } catch (e) {
      throw new HttpException({ outcome: 'error', code: (e as { code?: string }).code ?? 'plugin-failed' }, 503);
    }
  }
}
