import { Optional } from '@nestjs/common';
import { AuthnService } from '../../authn/flow.service.js';
import { BranchRegistries } from './branch-registries.js';
import { workspaceMode } from '../../workspace/context.js';
import { Body, Controller, Headers, HttpCode, HttpException, NotFoundException, Post } from '@nestjs/common';
import { BranchTestService } from '../../workspace/branch-test.js';
import { branchName } from '../../versioning/guards.js';
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
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches: BranchRegistries, @Optional() private readonly authn?: AuthnService, @Optional() private readonly branchTest?: BranchTestService) {}
  /** A branch test proceeds only with a well-formed branch and its valid admin-issued ticket; the refusal message is generic on purpose. */
  private async testRefusal(b: { branch?: unknown; ticket?: unknown }): Promise<string | null> {
    if (typeof b?.branch !== 'string' || !b.branch) return null;
    try { branchName(b.branch); } catch { return 'invalid data branch'; }
    if (b.branch === 'main') return 'main is the live sign-in already: nothing to test';
    if (!(await this.branchTest?.check(b.ticket, b.branch))) return 'This branch test link is invalid or expired. Start the test again from the branch bar.';
    return null;
  }
  private gate(tok: string | undefined) {
    const want = process.env.IAM_AUTH_GATE_TOKEN;
    if (!want || want.length < 8) throw new NotFoundException();
    const a = Buffer.from(tok ?? ''), w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w)) throw new HttpException({ outcome: 'error', code: 'bad-gate-token' }, 401);
  }

  /** First page of the sign-in form: which inputs sit next to the user name. `legacy` = no chain is live, the classic user + password form. */
  @Post('entry') @HttpCode(200)
  async entry(@Headers('x-gate-token') tok: string | undefined, @Body() b: { tenant?: string; chain?: string; branch?: string; ticket?: string }) {
    this.gate(tok);
    if (!this.authn || typeof b?.tenant !== 'string') return { mode: 'legacy' };
    const refuse = await this.testRefusal(b);
    if (refuse) return { mode: 'error', message: refuse };
    try { return await this.authn.entry(b.tenant, typeof b.chain === 'string' ? b.chain.slice(0, 40) : undefined, typeof b.branch === 'string' && b.branch ? b.branch : undefined); }
    catch (e) { if (typeof b.branch === 'string' && b.branch) return { mode: 'error', message: 'this data branch cannot be tested' }; throw new HttpException({ outcome: 'error', code: (e as { code?: string }).code ?? 'plugin-failed' }, 503); }
  }

  @Post('authenticate') @HttpCode(200)
  async authenticate(@Headers('x-gate-token') tok: string | undefined, @Body() b: { tenant?: string; subject?: string; password?: string; session?: string; chain?: string; branch?: string; ticket?: string; answers?: Record<string, string> }) {
    const want = process.env.IAM_AUTH_GATE_TOKEN;
    if (!want || want.length < 8) throw new NotFoundException();
    const a = Buffer.from(tok ?? ''), w = Buffer.from(want);
    if (a.length !== w.length || !timingSafeEqual(a, w)) throw new HttpException({ outcome: 'error', code: 'bad-gate-token' }, 401);
    if (this.authn && typeof b?.tenant === 'string' && (typeof b.session === 'string' || typeof b.subject === 'string')) {
      // Chain mode: the control plane runs the steps (a bare password is the first step's answer when that step is a password). null = no chain is live, fall through to the base password path.
      // A first page that names a branch needs its valid ticket; a running session is bound to its branch on the service side.
      if (typeof b.session !== 'string') { const refuse = await this.testRefusal(b); if (refuse) return { outcome: 'deny', reason: 'branch-test', message: refuse }; }
      try {
        const r = await this.authn.authenticate({ tenant: b.tenant, subject: b.subject, session: b.session, chain: typeof b.chain === 'string' ? b.chain : undefined, branch: typeof b.branch === 'string' && b.branch ? b.branch : undefined, answers: b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : typeof b.password === 'string' ? { password: b.password } : undefined });
        if (r) return r;
      } catch (e) {
        if (typeof b.branch === 'string' && b.branch) return { outcome: 'deny', reason: 'branch-test', message: 'this data branch cannot be tested' };
        throw new HttpException({ outcome: 'error', code: (e as { code?: string }).code ?? 'plugin-failed' }, 503);
      }
    }
    if (typeof b?.tenant !== 'string' || typeof b.subject !== 'string' || typeof b.password !== 'string') throw new HttpException({ outcome: 'error', code: 'bad-request' }, 400);
    { const refuse = await this.testRefusal(b); if (refuse) return { outcome: 'deny', reason: 'branch-test', message: refuse }; }
    try {
      const registry = workspaceMode() ? await this.branches.get(typeof b.branch === 'string' && b.branch ? b.branch : 'main') : this.reg;
      const r = await registry.callSlot<AuthenticateResult>(b.tenant, 'auth.password', 'auth.authenticate', { tenant: b.tenant, subject: b.subject, credential: { password: b.password } });
      return r.result.outcome === 'allow' ? { outcome: 'allow', servedBy: r.servedBy } : { outcome: 'deny', reason: r.result.outcome === 'deny' ? r.result.reason : 'challenge-unsupported', servedBy: r.servedBy };
    } catch (e) {
      throw new HttpException({ outcome: 'error', code: (e as { code?: string }).code ?? 'plugin-failed' }, 503);
    }
  }
}
