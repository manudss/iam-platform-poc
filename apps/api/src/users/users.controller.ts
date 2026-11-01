import { Body, Controller, Get, Param, Post, Put, UseGuards, NotFoundException } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { UsersService } from './users.service.js';
@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}
  private check(t: string) { if (t !== 'acme-demo') throw new NotFoundException('unknown directory'); }
  @Get() async list(@Param('tenant') t: string) { this.check(t); return { users: await this.users.list() }; }
  @Post() create(@Param('tenant') t: string, @Body() b: Record<string, unknown>) { this.check(t); return this.users.save(String(b?.id ?? ''), b, true, undefined, t); }
  @Put(':id') update(@Param('tenant') t: string, @Param('id') id: string, @Body() b: Record<string, unknown>) { this.check(t); return this.users.save(id, b, false, undefined, t); }
}
