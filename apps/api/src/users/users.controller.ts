import { Body, Controller, Get, Param, Post, Put, Req, UseGuards, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { assertSuperAdmin, filterPeople } from '../access/scope.js';
import { UsersService } from './users.service.js';
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  private check(t: string) { if (t !== 'acme-demo') throw new NotFoundException('unknown directory'); }
  @Get() async list(@Param('tenant') t: string, @Req() req: { user: { sub: string } }) { this.check(t); return { users: await filterPeople(t, req.user.sub, 'user:read', await this.users.list(), (u) => String(u.id)) }; }
  @Post() async create(@Param('tenant') t: string, @Req() req: { user: { sub: string } }, @Body() b: Record<string, unknown>) { this.check(t); await assertSuperAdmin(t, req.user.sub, 'Creating a person'); return this.users.save(String(b?.id ?? ''), b, true, undefined, t); }
  @Put(':id') async update(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string } }, @Body() b: Record<string, unknown>) { this.check(t); await assertSuperAdmin(t, req.user.sub, 'Changing a person record'); return this.users.save(id, b, false, undefined, t); }
}
