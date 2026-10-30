import { BadRequestException, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Patch, Post, Body, UseGuards, Optional } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';

const ID = /^[a-z0-9-]{1,32}$/;
/**
 * Role DEFINITIONS (id, label, sensitive flag) and separation-of-duties rules, edited by an administrator on the working branch.
 * What a role may DO lives in the Cedar policies and is not editable here: creating a role grants nothing. Ids never change (policies name them),
 * a role that is assigned or named in a rule cannot be deleted, a rule can only be removed with an explicit confirmation, and Apply still blocks
 * any assignment that violates a rule. Assigning people to roles stays in Assignments.
 */
@Injectable()
export class RolesService {
  constructor(@Optional() private readonly v?: VersioningService) {}
  private run<T>(write: boolean, fn: (c: Connection) => Promise<T>): Promise<T> {
    if (!this.v) throw new BadRequestException('no database');
    const v = this.v, branch = currentBranch(write);
    if (!write) return v.at(branch, fn);
    return workspaceMode() ? v.writeOn(branch, fn) : v.lock(() => v.at(branch, fn));
  }
  private async commit(c: Connection, msg: string) {
    const [d] = await c.query("select table_name from dolt_status where table_name in ('roles','sod_rules')");
    if ((d as unknown[]).length) { await c.query("call dolt_add('roles','sod_rules')"); await c.query('call dolt_commit(\'-m\', ?)', [msg]); }
  }
  list() { return this.run(false, async (c) => {
    const [roles] = await c.query('select r.id, r.label, r.is_sensitive, (select count(*) from assignments a where a.role_id=r.id) assigned from roles r order by r.id');
    const [rules] = await c.query('select role_a, role_b from sod_rules order by role_a, role_b');
    return { roles: (roles as any[]).map((r) => ({ id: r.id, label: r.label, is_sensitive: !!r.is_sensitive, assigned: Number(r.assigned) })), sodRules: rules as { role_a: string; role_b: string }[] };
  }); }
  private label(l: unknown) { if (typeof l !== 'string' || !l.trim() || l.length > 80) throw new BadRequestException('label: 1 to 80 characters'); return l.trim(); }
  async create(actor: string, b: { id?: unknown; label?: unknown; is_sensitive?: unknown }) {
    if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
    if (b.is_sensitive !== undefined && typeof b.is_sensitive !== 'boolean') throw new BadRequestException('is_sensitive must be boolean');
    const label = this.label(b.label);
    await this.run(true, async (c) => {
      const [x] = await c.query('select 1 from roles where id=?', [b.id]); if ((x as unknown[]).length) throw new ConflictException('role already exists');
      await c.query('insert into roles (id,label,is_sensitive) values (?,?,?)', [b.id, label, b.is_sensitive ?? false]); await this.commit(c, `roles: ${actor} created ${b.id}`);
    });
    return this.list();
  }
  async update(actor: string, id: string, b: { label?: unknown; is_sensitive?: unknown; id?: unknown }) {
    if (b?.id !== undefined && b.id !== id) throw new BadRequestException('a role id cannot change: policies refer to it');
    if (Object.keys(b ?? {}).some((k) => !['id', 'label', 'is_sensitive'].includes(k))) throw new BadRequestException('unknown role field');
    await this.run(true, async (c) => {
      const [x] = await c.query('select 1 from roles where id=?', [id]); if (!(x as unknown[]).length) throw new NotFoundException('unknown role');
      if (b?.label !== undefined) await c.query('update roles set label=? where id=?', [this.label(b.label), id]);
      if (b?.is_sensitive !== undefined) { if (typeof b.is_sensitive !== 'boolean') throw new BadRequestException('is_sensitive must be boolean'); await c.query('update roles set is_sensitive=? where id=?', [b.is_sensitive, id]); }
      await this.commit(c, `roles: ${actor} edited ${id}`);
    });
    return this.list();
  }
  async remove(actor: string, id: string) {
    await this.run(true, async (c) => {
      const [x] = await c.query('select 1 from roles where id=?', [id]); if (!(x as unknown[]).length) throw new NotFoundException('unknown role');
      const [a] = await c.query('select count(*) n from assignments where role_id=?', [id]); if (Number((a as any[])[0].n)) throw new ConflictException('the role is still assigned: remove the assignments first');
      const [s] = await c.query('select count(*) n from sod_rules where role_a=? or role_b=?', [id, id]); if (Number((s as any[])[0].n)) throw new ConflictException('the role is named in a separation-of-duties rule: remove the rule first (with confirmation)');
      await c.query('delete from roles where id=?', [id]); await this.commit(c, `roles: ${actor} deleted ${id}`);
    });
    return this.list();
  }
  async addRule(actor: string, b: { role_a?: unknown; role_b?: unknown }) {
    const [a, z] = [b?.role_a, b?.role_b];
    if (typeof a !== 'string' || typeof z !== 'string' || !ID.test(a) || !ID.test(z) || a === z) throw new BadRequestException('two different role ids required');
    await this.run(true, async (c) => {
      const [r] = await c.query('select count(*) n from roles where id in (?,?)', [a, z]); if (Number((r as any[])[0].n) !== 2) throw new BadRequestException('unknown role');
      await c.query('insert ignore into sod_rules (role_a,role_b) values (?,?)', [a, z]); await this.commit(c, `sod: ${actor} added ${a} x ${z}`);
    });
    return this.list();
  }
  async removeRule(actor: string, a: string, z: string, confirm: unknown) {
    if (confirm !== true) throw new BadRequestException('removing a separation-of-duties rule loosens a control: send { confirm: true }');
    await this.run(true, async (c) => { await c.query('delete from sod_rules where role_a=? and role_b=?', [a, z]); await this.commit(c, `sod: ${actor} removed ${a} x ${z}`); });
    return this.list();
  }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/roles')
export class RolesController {
  constructor(private readonly r: RolesService) {}
  private who(req: { user: { sub: string } }) { return req.user.sub; }
  @Get() list() { return this.r.list(); }
  @Post() create(@Body() b: any, @Req() q: any) { return this.r.create(this.who(q), b); }
  @Patch(':id') update(@Param('id') id: string, @Body() b: any, @Req() q: any) { return this.r.update(this.who(q), id, b); }
  @Delete(':id') remove(@Param('id') id: string, @Req() q: any) { return this.r.remove(this.who(q), id); }
  @Post('sod-rules') addRule(@Body() b: any, @Req() q: any) { return this.r.addRule(this.who(q), b); }
  @Post('sod-rules/remove') removeRule(@Body() b: { role_a?: string; role_b?: string; confirm?: unknown }, @Req() q: any) { return this.r.removeRule(this.who(q), String(b?.role_a), String(b?.role_b), b?.confirm); }
}
import { Req } from '@nestjs/common';
