/**
 * organizations plugin: organization management (tree of orgs, memberships assigned by an administrator).
 * The rules live in this folder; the core adapter owns the storage (Dolt/memory stores) and wires the
 * dependencies through `createOrgManager(deps)`.
 *
 * An assignment by an administrator is not a profile field: no profile setting can open it to the person.
 *
 * deps = {
 *   pluginActive(tenant, id, ref) -> boolean ('organizations' gate)
 *   store: { list(tenant, ref), write(tenant, actor, fn) }
 *   emit(type, tenant, payload)   -> durable audit event (member-added)
 * }
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(process.env.IAM_API_PACKAGE_JSON ?? new URL('../../apps/api/package.json', import.meta.url));
const { BadRequestException, ConflictException, NotFoundException } = require('@nestjs/common');

const ID = /^[a-z0-9-]{1,32}$/;
export const ORGANIZATIONS_PLUGIN = 'organizations';

export function createOrgManager(deps) {
  const need = async (t, ref) => { if (!(await deps.pluginActive(t, ORGANIZATIONS_PLUGIN, ref))) throw new NotFoundException('the organizations plugin is not enabled'); };
  const api = {
    async list(t) { await need(t, 'work'); return deps.store.list(t, 'work'); },
    async create(t, actor, b) {
      await need(t, 'work');
      if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters');
      const parent = b.parent_id == null || b.parent_id === '' ? null : String(b.parent_id);
      await deps.store.write(t, actor, (s) => {
        if (s.orgs.some((o) => o.id === b.id)) throw new ConflictException('organization already exists');
        if (parent && !s.orgs.some((o) => o.id === parent)) throw new BadRequestException('unknown parent organization');
        s.orgs.push({ id: b.id, name: b.name.trim(), parent_id: parent });
      });
      return api.list(t);
    },
    async update(t, actor, id, b) {
      await need(t, 'work');
      await deps.store.write(t, actor, (s) => {
        const o = s.orgs.find((x) => x.id === id); if (!o) throw new NotFoundException('unknown organization');
        if (b?.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters'); o.name = b.name.trim(); }
        if (b?.parent_id !== undefined) {
          const p = b.parent_id === null || b.parent_id === '' ? null : String(b.parent_id);
          if (p) { if (!s.orgs.some((x) => x.id === p)) throw new BadRequestException('unknown parent organization'); for (let c = p; c; c = s.orgs.find((x) => x.id === c)?.parent_id ?? null) if (c === id) throw new BadRequestException('an organization cannot be its own ancestor'); }
          o.parent_id = p;
        }
      });
      return api.list(t);
    },
    async remove(t, actor, id) {
      await need(t, 'work');
      await deps.store.write(t, actor, (s) => {
        if (!s.orgs.some((o) => o.id === id)) throw new NotFoundException('unknown organization');
        if (s.orgs.some((o) => o.parent_id === id)) throw new ConflictException('the organization has children');
        if (s.members.some((m) => m.org_id === id)) throw new ConflictException('the organization still has members');
        s.orgs = s.orgs.filter((o) => o.id !== id);
      });
      return api.list(t);
    },
    /** An assignment by an administrator. It is not a profile field and no profile setting can open it to the person. */
    async assign(t, actor, subject, orgIds) {
      await need(t, 'work');
      if (!ID.test(subject)) throw new BadRequestException('invalid user id');
      if (!Array.isArray(orgIds) || orgIds.length > 20 || orgIds.some((x) => typeof x !== 'string')) throw new BadRequestException('orgIds: list of organization ids');
      const before = new Set((await deps.store.list(t, 'work')).members.filter((m) => m.subject === subject).map((m) => m.org_id));
      await deps.store.write(t, actor, (s) => {
        for (const id of orgIds) if (!s.orgs.some((o) => o.id === id)) throw new BadRequestException(`unknown organization ${id}`);
        s.members = s.members.filter((m) => m.subject !== subject).concat([...new Set(orgIds)].map((org_id) => ({ subject, org_id })));
      });
      for (const org of [...new Set(orgIds)]) if (!before.has(org)) deps.emit('organization.member-added', t, { subject, organization: org, actor });
      return { subject, orgIds: [...new Set(orgIds)] };
    },
    /** Read-only section shown on a profile (live for the person, working for the administrator). Empty when the plugin is off. */
    async section(t, subject, ref) {
      if (!(await deps.pluginActive(t, ORGANIZATIONS_PLUGIN, ref))) return undefined;
      const s = await deps.store.list(t, ref); const names = new Map(s.orgs.map((o) => [o.id, o.name]));
      return s.members.filter((m) => m.subject === subject).map((m) => ({ id: m.org_id, name: names.get(m.org_id) ?? m.org_id }));
    },
  };
  return api;
}

// No bus hooks: the plugin serves its management rules through the engine the core adapter wires.
export default {};
