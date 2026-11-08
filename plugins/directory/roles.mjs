/**
 * directory plugin: role and separation-of-duties management rules.
 * The rules live in this folder; the core adapter wires the versioned SQL connection
 * through `createRolesManager(deps)`.
 *
 * Role DEFINITIONS (id, label, sensitive flag) and separation-of-duties rules, edited by an administrator
 * on the working branch. What a role may DO lives in the Cedar policies and is not editable here: creating
 * a role grants nothing. Ids never change (policies name them), a role that is assigned or named in a rule
 * cannot be deleted, a rule can only be removed with an explicit confirmation, and Apply still blocks any
 * assignment that violates a rule. Assigning people to roles stays in Assignments.
 *
 * deps = { run(write, fn) -> fn(connection) } - runs fn on the working branch (write) or current branch (read).
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException, ConflictException, NotFoundException } = require('@nestjs/common');

const ID = /^[a-z0-9-]{1,32}$/;

export function createRolesManager(deps) {
  async function commit(c, msg) {
    const [d] = await c.query("select table_name from dolt_status where table_name in ('roles','sod_rules')");
    if (d.length) { await c.query("call dolt_add('roles','sod_rules')"); await c.query("call dolt_commit('-m', ?)", [msg]); }
  }
  const label = (l) => { if (typeof l !== 'string' || !l.trim() || l.length > 80) throw new BadRequestException('label: 1 to 80 characters'); return l.trim(); };
  const api = {
    list() {
      return deps.run(false, async (c) => {
        const [roles] = await c.query('select r.id, r.label, r.is_sensitive, (select count(*) from assignments a where a.role_id=r.id) assigned from roles r order by r.id');
        const [rules] = await c.query('select role_a, role_b from sod_rules order by role_a, role_b');
        return { roles: roles.map((r) => ({ id: r.id, label: r.label, is_sensitive: !!r.is_sensitive, assigned: Number(r.assigned) })), sodRules: rules };
      });
    },
    async create(actor, b) {
      if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
      if (b.is_sensitive !== undefined && typeof b.is_sensitive !== 'boolean') throw new BadRequestException('is_sensitive must be boolean');
      const lab = label(b.label);
      await deps.run(true, async (c) => {
        const [x] = await c.query('select 1 from roles where id=?', [b.id]); if (x.length) throw new ConflictException('role already exists');
        await c.query('insert into roles (id,label,is_sensitive) values (?,?,?)', [b.id, lab, b.is_sensitive ?? false]); await commit(c, `roles: ${actor} created ${b.id}`);
      });
      return api.list();
    },
    async update(actor, id, b) {
      if (b?.id !== undefined && b.id !== id) throw new BadRequestException('a role id cannot change: policies refer to it');
      if (Object.keys(b ?? {}).some((k) => !['id', 'label', 'is_sensitive'].includes(k))) throw new BadRequestException('unknown role field');
      await deps.run(true, async (c) => {
        const [x] = await c.query('select 1 from roles where id=?', [id]); if (!x.length) throw new NotFoundException('unknown role');
        if (b?.label !== undefined) await c.query('update roles set label=? where id=?', [label(b.label), id]);
        if (b?.is_sensitive !== undefined) { if (typeof b.is_sensitive !== 'boolean') throw new BadRequestException('is_sensitive must be boolean'); await c.query('update roles set is_sensitive=? where id=?', [b.is_sensitive, id]); }
        await commit(c, `roles: ${actor} edited ${id}`);
      });
      return api.list();
    },
    async remove(actor, id) {
      await deps.run(true, async (c) => {
        const [x] = await c.query('select 1 from roles where id=?', [id]); if (!x.length) throw new NotFoundException('unknown role');
        const [a] = await c.query('select count(*) n from assignments where role_id=?', [id]); if (Number(a[0].n)) throw new ConflictException('the role is still assigned: remove the assignments first');
        const [s] = await c.query('select count(*) n from sod_rules where role_a=? or role_b=?', [id, id]); if (Number(s[0].n)) throw new ConflictException('the role is named in a separation-of-duties rule: remove the rule first (with confirmation)');
        await c.query('delete from roles where id=?', [id]); await commit(c, `roles: ${actor} deleted ${id}`);
      });
      return api.list();
    },
    async addRule(actor, b) {
      const [a, z] = [b?.role_a, b?.role_b];
      if (typeof a !== 'string' || typeof z !== 'string' || !ID.test(a) || !ID.test(z) || a === z) throw new BadRequestException('two different role ids required');
      await deps.run(true, async (c) => {
        const [r] = await c.query('select count(*) n from roles where id in (?,?)', [a, z]); if (Number(r[0].n) !== 2) throw new BadRequestException('unknown role');
        await c.query('insert ignore into sod_rules (role_a,role_b) values (?,?)', [a, z]); await commit(c, `sod: ${actor} added ${a} x ${z}`);
      });
      return api.list();
    },
    async removeRule(actor, a, z, confirm) {
      if (confirm !== true) throw new BadRequestException('removing a separation-of-duties rule loosens a control: send { confirm: true }');
      await deps.run(true, async (c) => { await c.query('delete from sod_rules where role_a=? and role_b=?', [a, z]); await commit(c, `sod: ${actor} removed ${a} x ${z}`); });
      return api.list();
    },
  };
  return api;
}
