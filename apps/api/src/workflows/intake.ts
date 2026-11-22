import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SignupService } from '../profile/signup.service.js';
import { ProfileService } from '../profile/profile.service.js';

/** Admin intake operations reuse the existing business services, not SQL copies of their rules.
 * Snapshot digests bind a resolution to the request read by this workflow. No password/hash/token is exposed.
 * Profile resolution is immediate. Signup approval is refused until publication-aware finalization exists.
 */
@Injectable()
export class WorkflowIntake {
  constructor(@Optional() private readonly signup?: SignupService, @Optional() private readonly profile?: ProfileService) {}
  private admin(starter: string) {
    const admins = (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    if (!starter || !admins.includes(starter)) throw new ForbiddenException('intake resolution requires a run started by an administrator');
  }
  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
  private async raw(tenant: string, kind: string, subject: string) {
    if (kind === 'signup') {
      if (!this.signup) throw new BadRequestException('signup service unavailable');
      const request = (this.signup.list(tenant).requests as { id: string; confirmed: boolean }[]).find(r => r.id === subject);
      if (!request) throw new BadRequestException('no signup request in this tenant');
      return request;
    }
    if (kind === 'profile') {
      if (!this.profile) throw new BadRequestException('profile service unavailable');
      const request = (await this.profile.reviews(tenant)).reviews.find(r => r.id === subject);
      if (!request) throw new BadRequestException('no pending profile review in this tenant and branch');
      return request;
    }
    throw new BadRequestException('kind: signup or profile');
  }
  async read(tenant: string, kind: string, subject: string, starter: string) {
    this.admin(starter);
    const request = await this.raw(tenant, kind, subject);
    return { kind, subject, snapshot: this.hash(request), ...(kind === 'signup' ? { confirmed: (request as { confirmed: boolean }).confirmed } : {}) };
  }
  async prepareResolve(kind: string, decision: string, starter: string) {
    this.admin(starter);
    if (kind === 'signup' && decision === 'approve') throw new ForbiddenException('workflow signup approval requires publication-aware request finalization; no signup effect was performed');
  }
  async resolve(tenant: string, kind: string, subject: string, snapshot: string, decision: string, starter: string): Promise<{ kind: string; subject: string; resolved: string; publicationRequired?: boolean; immediate?: boolean }> {
    this.admin(starter);
    if (!['approve', 'reject'].includes(decision)) throw new BadRequestException('decision: approve or reject');
    if (subject.split(';')[0] === starter) throw new ForbiddenException('a starter cannot resolve their own signup or profile request');
    const request = await this.raw(tenant, kind, subject);
    if (!/^[a-f0-9]{64}$/.test(snapshot) || this.hash(request) !== snapshot) throw new ConflictException('request changed since it was read; read and review again');
    await this.prepareResolve(kind, decision, starter);
    if (kind === 'signup') this.signup!.reject(subject, tenant, snapshot);
    else await this.profile!.resolveReviewedSnapshot(tenant, subject, decision === 'approve', starter, snapshot);
    return { kind, subject, resolved: decision, immediate: true };
  }
}
