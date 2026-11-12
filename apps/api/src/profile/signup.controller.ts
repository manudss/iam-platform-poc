import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard, OptionalAuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { SignupService } from './signup.service.js';

/** The two public routes have no guard on purpose and can only create a request. Everything else needs an administrator. */
@Controller('tenants/:tenant/signup')
export class SignupController {
  constructor(private readonly s: SignupService) {}
  /** The form the public sees: only fields the LIVE configuration asks at sign-up. 404 while sign-up is closed. */
  @Get('schema') schema(@Param('tenant') t: string) { return this.s.schema(t); }
  // Public on purpose, but a presented branch-test token is refused: a test session never creates a real account, even by a manual call.
  @UseGuards(OptionalAuthGuard) @Post() submit(@Param('tenant') t: string, @Body() b: unknown, @Req() req: { ip?: string; user?: { branch?: string } }) { assertNotBranchTest(req); return this.s.submit(t, b, req.ip ?? 'unknown'); }
  @UseGuards(OptionalAuthGuard) @Post('confirm') confirm(@Param('tenant') t: string, @Body() b: { token?: unknown }, @Req() req: { user?: { branch?: string } }) { assertNotBranchTest(req); return this.s.confirm(t, b?.token); }
  @UseGuards(AuthGuard, AdminGuard) @Get('delivery-status') deliveryStatus(@Param('tenant') t: string) { return this.s.deliveryStatus(t); }
  @UseGuards(AuthGuard, AdminGuard) @Get('requests') list() { return this.s.list(); }
  @UseGuards(AuthGuard, AdminGuard) @Post('requests/:id/approve') approve(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string; branch?: string } }) { assertNotBranchTest(req); return this.s.approve(t, id, req.user.sub); }
  @UseGuards(AuthGuard, AdminGuard) @Delete('requests/:id') reject(@Param('id') id: string, @Req() req: { user?: { branch?: string } }) { assertNotBranchTest(req); return this.s.reject(id); }
}
