import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Optional, Param, Put, Post, Req, UseGuards } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { methodType, methodComponent } from './methods.js';
import { SEED_CONFIG, isEmptyConfig, validateConfig } from './config.js';
import { newTotpSecret, otpauthUri } from './totp.js';

/**
 * Admin API for authentication methods and chains (one tenant at a time).
 * Reads need a sign-in. Writes need the admin capability and, in workspace mode, a working branch: they never change live sign-in until Apply.
 */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/auth')
export class AuthnAdminController {
  constructor(private readonly authn: AuthnService, @Optional() private readonly profile?: ProfileService) {}

  /** The console's readonly/hidden component configuration is enforced here too, not only in the UI (review). */
  private async assertSurfaceAllows(t: string, typeId: string, surface: 'self' | 'admin') {
    const c = methodComponent(typeId);
    if (!c || !this.profile) return; // a type without a profile component has no surface configuration to enforce
    const mode = await this.profile.componentMode(t, c.plugin, c.id, surface, surface === 'admin' ? 'work' : 'live');
    if (mode !== 'manage') throw new ForbiddenException(`the profile configuration sets this component to ${mode} for ${surface === 'admin' ? 'administrators' : 'the person'}: enrollment changes are refused`);
  }

  @Get() async get(@Param('tenant') t: string) {
    const stored = await this.authn.workingConfig(t), live = await this.authn.liveConfig(t), seeded = isEmptyConfig(stored), work = seeded ? validateConfig(SEED_CONFIG) : stored;
    return { tenant: t, catalogue: this.authn.catalogue(), working: { config: work, seeded, analyses: this.authn.analyses(work), availability: await this.authn.availability(t, work, 'work') }, live: { config: live, analyses: this.authn.analyses(live), signInMode: live.chains.some((c) => c.enabled) ? 'chain' : 'base-password' } };
  }
  /** Validates and analyzes a DRAFT configuration without saving it, so the console can show levels, factors and warnings while editing. */
  @Post('analyze') analyze(@Body() b: { config?: unknown }) {
    const cfg = validateConfig(b?.config);
    return { valid: true, config: cfg, analyses: this.authn.analyses(cfg) };
  }
  @UseGuards(AdminGuard) @Put() async put(@Param('tenant') t: string, @Body() b: { config?: unknown }) {
    const cfg = await this.authn.saveConfig(t, b?.config);
    return { saved: true, config: cfg, analyses: this.authn.analyses(cfg) };
  }

  private async instance(t: string, id: string) {
    const all = [...(await this.authn.workingConfig(t)).methods, ...(await this.authn.liveConfig(t)).methods];
    const m = all.find((x) => x.id === id); if (!m) throw new NotFoundException('unknown method instance');
    return { m, type: methodType(m.type)! };
  }
  private user(u: string) { if (!/^[a-z0-9-]{1,32}$/.test(u)) throw new BadRequestException('invalid user id'); return u; }

  /** Enrollment counts per method instance (the admin profile component's overview). Never the secrets. */
  @UseGuards(AdminGuard) @Get('enrollment-stats') async enrollmentStats(@Param('tenant') t: string) { return { tenant: t, instances: await this.authn.enroll.stats(t) }; }

  @UseGuards(AdminGuard) @Get('enrollments/:user') async enrollments(@Param('tenant') t: string, @Param('user') u: string) { return { user: this.user(u), enrollments: await this.authn.enroll.status(t, this.user(u)) }; }

  /**
   * DEMO provisioning by an administrator. The secret or PIN is returned once and never again. A real product enrolls from the user's own session.
   * Body: { email } for e-mail codes; { pin } or { length } for digit codes (a PIN typed here goes to the server over this request only).
   */
  @UseGuards(AdminGuard) @Post('enrollments/:user/:instance') async provision(@Param('tenant') t: string, @Param('user') u: string, @Param('instance') inst: string, @Body() b: { email?: string; pin?: string; length?: number }, @Req() req: { user?: { branch?: string } }) {
    assertNotBranchTest(req); // enrollments are shared, unversioned secrets: never written from a branch-test session
    this.user(u); const { m, type } = await this.instance(t, inst);
    await this.assertSurfaceAllows(t, type.id, 'admin');
    if (type.id === 'totp') {
      const secret = newTotpSecret(); await this.authn.enroll.setTotp(t, u, inst, secret);
      return { instance: inst, type: type.id, shownOnce: { secret, otpauthUri: otpauthUri(String(m.config.issuer ?? 'IAM POC'), u, secret, Number(m.config.periodSeconds ?? 30), Number(m.config.digits ?? 6)) }, note: 'Shown once. Demo provisioning only.' };
    }
    if (type.id === 'digit-code') {
      const len = Number(m.config.length ?? 6);
      const pin = typeof b?.pin === 'string' ? b.pin : Array.from({ length: len }, () => String(randomInt(0, 10))).join('');
      if (!/^\d+$/.test(pin) || pin.length !== len) throw new BadRequestException(`PIN must be exactly ${len} digits (this method's setting)`);
      await this.authn.enroll.setPin(t, u, inst, pin);
      return { instance: inst, type: type.id, ...(typeof b?.pin === 'string' ? {} : { shownOnce: { pin } }), note: 'A PIN is never shown again.' };
    }
    if (type.id === 'email-otp') {
      if (typeof b?.email !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,120}$/.test(b.email)) throw new BadRequestException('email address required');
      await this.authn.enroll.setEmail(t, u, inst, b.email); return { instance: inst, type: type.id, email: b.email, note: 'Codes go to the demo outbox, not to this address.' };
    }
    throw new BadRequestException(`${type.id} needs no enrollment`);
  }
  @UseGuards(AdminGuard) @Delete('enrollments/:user/:instance') async unenroll(@Param('tenant') t: string, @Param('user') u: string, @Param('instance') inst: string, @Req() req: { user?: { branch?: string } }) {
    assertNotBranchTest(req); const { type } = await this.instance(t, inst); await this.assertSurfaceAllows(t, type.id, 'admin'); await this.authn.enroll.remove(t, this.user(u), inst); return { removed: true }; }

  /** Demo outbox: what the simulated e-mail delivery wrote. Administrators only; contains one-time codes in clear. */
  @UseGuards(AdminGuard) @Get('outbox') outbox(@Param('tenant') t: string, @Req() req: { user?: { branch?: string } }) {
    // Codes of the shared demo outbox are read from the normal console, not from a test session.
    assertNotBranchTest(req); return { adapter: 'demo-outbox', simulated: true, messages: this.authn.outbox.list(t) }; }
  @UseGuards(AdminGuard) @Delete('outbox') clear(@Param('tenant') t: string, @Req() req: { user?: { branch?: string } }) {
    assertNotBranchTest(req); this.authn.outbox.clear(t); return { cleared: true }; }
}
