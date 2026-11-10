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
  @Get() async list(@Param('tenant') t: string, @Req() req: { user: { sub: string } }) { this.check(t); const all = await this.users.list(); const mine = await filterPeople(t, req.user.sub, 'user:read', all, (u) => String(u.id));
    if (mine.length === all.length) return { users: mine };
    // Everyone sees the list of managers (id, name, department only, marked reference): the manager field shows the real manager and lists every candidate. Read only, not listed as a person; changing a manager stays a policy decision.
    type Row = Record<string, unknown>; const rows = all as unknown as Row[]; const have = new Set(mine.map((u) => String(u.id)));
    const managerIds = new Set(rows.map((r) => String(r.manager_id ?? '')).filter(Boolean)); const refs: Row[] = [];
    for (const r of rows) if (managerIds.has(String(r.id)) && !have.has(String(r.id))) refs.push({ id: r.id, display_name: r.display_name, department: r.department, reference: true });
    return { users: [...mine, ...refs] }; }
  @Post() async create(@Param('tenant') t: string, @Req() req: { user: { sub: string } }, @Body() b: Record<string, unknown>) { this.check(t); await assertSuperAdmin(t, req.user.sub, 'Creating a person'); return this.users.save(String(b?.id ?? ''), b, true, undefined, t); }
  @Put(':id') async update(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string } }, @Body() b: Record<string, unknown>) { this.check(t); await assertSuperAdmin(t, req.user.sub, 'Changing a person record'); return this.users.save(id, b, false, undefined, t); }
}
