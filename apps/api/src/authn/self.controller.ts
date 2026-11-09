import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { methodType, methodComponent } from './methods.js';
import { newTotpSecret, otpauthUri, totpVerify } from './totp.js';
import { UsersService } from '../users/users.service.js';
import { ProfileService } from '../profile/profile.service.js';

/**
 * Self-service enrollment (profile "Security" components): a signed-in person manages their OWN authenticator,
 * PIN and password. The subject always comes from the token. Enrollments are shared, unversioned secrets: they are
 * never written from a branch-test session, and a secret is returned exactly once at creation.
 */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/auth')
export class AuthnSelfController {
  constructor(private readonly authn: AuthnService, private readonly users: UsersService, @Optional() private readonly profile?: ProfileService) {}

  /** The readonly/hidden component configuration is enforced here too, not only in the UI (review). The self
   * surface is the live one: the person's own page does not edit a working branch. */
  private async assertSurfaceAllows(t: string, typeId: string) {
    const c = methodComponent(typeId);
    if (!c || !this.profile) return;
    const mode = await this.profile.componentMode(t, c.plugin, c.id, 'self', 'live');
    if (mode !== 'manage') throw new ForbiddenException(`the profile configuration sets this component to ${mode} for the person: enrollment changes are refused`);
  }

  private async instance(t: string, id: string) {
    const m = (await this.authn.liveConfig(t)).methods.find((x) => x.id === id && x.enabled);
    if (!m) throw new NotFoundException('unknown or disabled method instance');
    return { m, type: methodType(m.type)! };
  }

  /** What the person has, per method instance (never the secrets themselves). */
  @Get('me/enrollments') async enrollments(@Param('tenant') t: string, @Req() req: { user: { sub: string } }) {
    const live = await this.authn.liveConfig(t);
    const status = await this.authn.enroll.status(t, req.user.sub);
    return { user: req.user.sub, methods: live.methods.filter((m) => m.enabled).map((m) => ({ id: m.id, type: m.type, name: m.name })), enrollments: status };
  }

  /** TOTP self-enrollment: creates the secret and shows it ONCE. Already enrolled: revoke first. */
  @Post('me/enrollments/:instance/totp') async enrollTotp(@Param('tenant') t: string, @Param('instance') inst: string, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { m, type } = await this.instance(t, inst);
    if (type.id !== 'totp') throw new BadRequestException(`${inst} is not an authenticator method`);
    await this.assertSurfaceAllows(t, type.id);
    if ((await this.authn.enroll.status(t, req.user.sub))[inst]?.totp) throw new ConflictException('an authenticator is already enrolled: remove it first');
    const secret = newTotpSecret();
    await this.authn.enroll.setTotp(t, req.user.sub, inst, secret);
    return { instance: inst, type: type.id, shownOnce: { secret, otpauthUri: otpauthUri(String(m.config.issuer ?? 'IAM POC'), req.user.sub, secret, Number(m.config.periodSeconds ?? 30), Number(m.config.digits ?? 6)) }, note: 'Shown once. Add it to your authenticator app, then confirm with a code.' };
  }

  /** Confirms a fresh TOTP enrollment with a code from the app (proof of possession; the enrollment is already usable). */
  @Post('me/enrollments/:instance/totp/confirm') async confirmTotp(@Param('tenant') t: string, @Param('instance') inst: string, @Body() b: { code?: string }, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { m, type } = await this.instance(t, inst);
    if (type.id !== 'totp') throw new BadRequestException(`${inst} is not an authenticator method`);
    const rec = await this.authn.enroll.totp(t, req.user.sub, inst);
    if (!rec) throw new NotFoundException('no authenticator enrolled on this method');
    if (typeof b?.code !== 'string' || !/^\d{6,8}$/.test(b.code)) throw new BadRequestException('code: the 6 to 8 digits shown by the app');
    const step = totpVerify(rec.secret, b.code, Date.now(), Number(m.config.periodSeconds ?? 30), Number(m.config.digits ?? 6), 1);
    if (step === null) throw new ForbiddenException('the code does not match: check the app and try again');
    return { confirmed: true };
  }

  /** PIN self-service: set or change. Changing an existing PIN requires the current one. */
  @Put('me/enrollments/:instance/pin') async setPin(@Param('tenant') t: string, @Param('instance') inst: string, @Body() b: { pin?: string; current?: string }, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { m, type } = await this.instance(t, inst);
    if (type.id !== 'digit-code') throw new BadRequestException(`${inst} is not a PIN method`);
    await this.assertSurfaceAllows(t, type.id);
    const len = Number(m.config.length ?? 6);
    if (typeof b?.pin !== 'string' || !/^\d+$/.test(b.pin) || b.pin.length !== len) throw new BadRequestException(`PIN must be exactly ${len} digits (this method's setting)`);
    const existing = await this.authn.enroll.pinLength(t, req.user.sub, inst);
    if (existing && !(typeof b?.current === 'string' && await this.authn.enroll.verifyPinFull(t, req.user.sub, inst, b.current)))
      throw new ForbiddenException('the current PIN does not match');
    await this.authn.enroll.setPin(t, req.user.sub, inst, b.pin);
    return { instance: inst, type: type.id, changed: true, note: 'The PIN is never shown anywhere.' };
  }

  /** Removes one of the person's own enrollments (any method type). */
  @Delete('me/enrollments/:instance') async remove(@Param('tenant') t: string, @Param('instance') inst: string, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { type } = await this.instance(t, inst);
    await this.assertSurfaceAllows(t, type.id);
    await this.authn.enroll.remove(t, req.user.sub, inst);
    return { removed: true };
  }

  /** Password change: the current password re-authenticates the request. */
  @Post('me/password') async password(@Param('tenant') t: string, @Body() b: { current?: string; next?: string }, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    if (typeof b?.current !== 'string' || typeof b?.next !== 'string') throw new BadRequestException('current and next are required');
    await this.assertSurfaceAllows(t, 'password');
    await this.users.changePassword(t, req.user.sub, b.current, b.next);
    return { changed: true };
  }
}
