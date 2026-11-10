import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, NotFoundException, Optional, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
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

  /** Origin of the page that calls (behind the demo edge): passkey ceremonies are bound to it. */
  private pageOrigin(h: Record<string, string | string[] | undefined>) {
    const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
    const proto = first(h['x-forwarded-proto']).split(',')[0].trim() || 'http';
    const host = first(h['x-forwarded-host']).split(',')[0].trim() || first(h['host']).split(',')[0].trim();
    if (!/^[\w.:-]{1,200}$/.test(host)) throw new BadRequestException('the page origin is missing or invalid');
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  /** Passkey self-service, step 1: creation options for the authenticator (the challenge lives 5 minutes server-side). */
  @Post('me/enrollments/:instance/passkey/options') async passkeyOptions(@Param('tenant') t: string, @Param('instance') inst: string, @Headers() h: Record<string, string | string[] | undefined>, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { m, type } = await this.instance(t, inst);
    if (type.id !== 'webauthn') throw new BadRequestException(`${inst} is not a passkey method`);
    await this.assertSurfaceAllows(t, type.id);
    const status = await this.authn.enroll.status(t, req.user.sub);
    const existing = status[inst]?.webauthn;
    if (Array.isArray(existing) && existing.length >= 10) throw new ConflictException('at most 10 passkeys per method: remove one first');
    const r = await this.authn.webauthnEnrollOptions(t, req.user.sub, inst, m.config, this.pageOrigin(h));
    if (!r.ok) throw new BadRequestException(r.reason);
    return { instance: inst, type: type.id, options: r.options };
  }

  /** Passkey self-service, step 2: the attestation is checked by the method plugin, then the credential is stored. */
  @Post('me/enrollments/:instance/passkey') async passkeyFinish(@Param('tenant') t: string, @Param('instance') inst: string, @Body() b: { name?: string; credential?: Record<string, unknown> }, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { m, type } = await this.instance(t, inst);
    if (type.id !== 'webauthn') throw new BadRequestException(`${inst} is not a passkey method`);
    await this.assertSurfaceAllows(t, type.id);
    if (!b?.credential || typeof b.credential !== 'object') throw new BadRequestException('credential: the attestation answer of the authenticator');
    if (JSON.stringify(b.credential).length > 16384) throw new BadRequestException('credential: too large');
    if (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 60)) throw new BadRequestException('name: at most 60 characters');
    const r = await this.authn.webauthnEnrollVerify(t, req.user.sub, inst, m.config, b.credential, typeof b.name === 'string' && b.name.trim() ? b.name.trim() : undefined);
    if (!r.ok) throw new ForbiddenException(r.reason);
    return { instance: inst, type: type.id, ...r };
  }

  /** Removes one of the person's own passkeys. */
  @Delete('me/enrollments/:instance/passkey/:cred') async removePasskey(@Param('tenant') t: string, @Param('instance') inst: string, @Param('cred') cred: string, @Req() req: { user: { sub: string; branch?: string } }) {
    assertNotBranchTest(req);
    const { type } = await this.instance(t, inst);
    if (type.id !== 'webauthn') throw new BadRequestException(`${inst} is not a passkey method`);
    await this.assertSurfaceAllows(t, type.id);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(cred)) throw new BadRequestException('unknown credential id');
    if (!(await this.authn.enroll.removeWebAuthnCredential(t, req.user.sub, inst, cred))) throw new NotFoundException('no such passkey');
    return { removed: true };
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
