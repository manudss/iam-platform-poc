import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { branchName } from '../versioning/guards.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { workspaceMode } from './context.js';

/** Branch test is a hosted workspace-mode feature; IAM_BRANCH_TEST=0 turns it off everywhere (console route, gate, sign-in options). */
export const branchTestEnabled = () => workspaceMode() && process.env.IAM_BRANCH_TEST !== '0';
const TTL_MS = 10 * 60_000;

/**
 * Short-lived tickets that open a sign-in test on one Dolt data branch (see docs/branch-test.md).
 * A ticket is issued to an administrator from the console's branch bar and authorizes the PUBLIC sign-in entry points
 * (options and the core's gate) to reveal and use that branch's configuration: knowing a branch name is never enough.
 * In memory on purpose: tickets die with the API process, like the sign-in sessions they protect.
 */
@Injectable()
export class BranchTestService {
  private tickets = new Map<string, { branch: string; subject: string; exp: number }>();
  now = () => Date.now();
  constructor(private readonly v: VersioningService) {}

  async create(subject: string, branch: string): Promise<{ ticket: string; branch: string; expiresIn: number }> {
    if (!branchTestEnabled()) throw new ForbiddenException('branch test is disabled');
    branchName(branch);
    if (branch === 'main') throw new BadRequestException('main is the live sign-in already: nothing to test');
    if (!(await this.v.branches()).branches.some((b) => b.name === branch)) throw new NotFoundException('unknown branch');
    this.sweep();
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { branch, subject, exp: this.now() + TTL_MS });
    return { ticket, branch, expiresIn: TTL_MS / 1000 };
  }

  /** True only when the ticket exists, names exactly this branch and is still valid. No detail leaks through a refusal. */
  check(ticket: unknown, branch: unknown): boolean {
    if (!branchTestEnabled() || typeof ticket !== 'string' || typeof branch !== 'string') return false;
    const t = this.tickets.get(ticket);
    return !!t && t.branch === branch && t.exp > this.now();
  }

  private sweep() { const n = this.now(); for (const [k, t] of this.tickets) if (t.exp < n) this.tickets.delete(k); }
}
