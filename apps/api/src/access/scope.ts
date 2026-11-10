import { createConnection } from 'mysql2/promise';
import { ForbiddenException } from '@nestjs/common';
import { screenAccessOn } from '../auth/screen-decision.js';

/**
 * People scopes: which persons a caller may read, manage or assign roles to. The rule is Cedar (user:read, user:manage, assignment:change); this file only
 * builds what Cedar needs: the target as an entity whose parents are its manager chain (identities.manager_id, recursive) and its organisations
 * (org_memberships + organizations.parent_id, recursive), and the caller's own organisations (context.admin_orgs). Both hierarchies are read from the live data on main.
 */
export interface Hierarchy { managerOf: Map<string, string>; orgsOf: Map<string, string[]>; parentOrg: Map<string, string> }
export type PersonAction = 'user:read' | 'user:manage' | 'assignment:change';

export async function readHierarchy(tenant: string, ref = 'main'): Promise<Hierarchy> {
  const c = await createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', database: process.env.DOLT_DATABASE ?? 'iam' });
  try {
    const at = /^[A-Za-z0-9._\/-]{1,80}$/.test(ref) ? ref : 'main';
    const h: Hierarchy = { managerOf: new Map(), orgsOf: new Map(), parentOrg: new Map() };
    const [ids] = await c.query(`select id, manager_id from identities as of '${at}'`);
    for (const r of ids as { id: string; manager_id: string | null }[]) if (r.manager_id) h.managerOf.set(r.id, r.manager_id);
    try {
      const [ms] = await c.query(`select subject, org_id from org_memberships as of '${at}' where tenant = ?`, [tenant]);
      for (const r of ms as { subject: string; org_id: string }[]) h.orgsOf.set(r.subject, [...(h.orgsOf.get(r.subject) ?? []), r.org_id]);
      const [os] = await c.query(`select id, parent_id from organizations as of '${at}' where tenant = ?`, [tenant]);
      for (const r of os as { id: string; parent_id: string | null }[]) if (r.parent_id) h.parentOrg.set(r.id, r.parent_id);
    } catch { /* the organisations plugin tables do not exist: only the manager chain applies */ }
    return h;
  } finally { await c.end(); }
}

/** Manager chain of `id`, nearest first, cycle safe and capped. */
export function chainOf(h: Hierarchy, id: string): string[] {
  const out: string[] = []; let cur = h.managerOf.get(id);
  while (cur && !out.includes(cur) && out.length < 50) { out.push(cur); cur = h.managerOf.get(cur); }
  return out;
}
function orgAncestors(h: Hierarchy, org: string): string[] {
  const out = [org]; let cur = h.parentOrg.get(org);
  while (cur && !out.includes(cur) && out.length < 50) { out.push(cur); cur = h.parentOrg.get(cur); }
  return out;
}
/** Cedar entities for a set of persons: each with its manager chain as User parents and its organisations as Org parents; the Org tree itself. */
export function entitiesFor(h: Hierarchy, persons: string[]): object[] {
  const users = new Set<string>(); const orgs = new Set<string>();
  const add = (id: string) => { if (users.has(id)) return; users.add(id); for (const m of chainOf(h, id)) users.add(m); for (const o of h.orgsOf.get(id) ?? []) for (const a of orgAncestors(h, o)) orgs.add(a); };
  for (const p of persons) { add(p); for (const m of chainOf(h, p)) add(m); }
  // The immediate manager is the only User parent: `in` is transitive, so the chain is rebuilt by Cedar itself.
  const list: object[] = [];
  for (const u of users) { const m = h.managerOf.get(u); list.push({ uid: { type: 'User', id: u }, attrs: {}, parents: [...(m ? [{ type: 'User', id: m }] : []), ...(h.orgsOf.get(u) ?? []).map((o) => ({ type: 'Org', id: o }))] }); }
  for (const o of orgs) { const p = h.parentOrg.get(o); list.push({ uid: { type: 'Org', id: o }, attrs: {}, parents: p ? [{ type: 'Org', id: p }] : [] }); }
  return list;
}

export interface ScopeAnswer { allow: boolean; reasons: string[]; engine: boolean }
export async function askPerson(tenant: string, h: Hierarchy, actor: string, action: PersonAction, target: string, role?: string): Promise<ScopeAnswer> {
  const adminOrgs = [...new Set((h.orgsOf.get(actor) ?? []).flatMap((o) => [o]))];
  const res = await fetch(`${process.env.IAM_CORE_URL}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
    body: JSON.stringify({ tenant, principal: `User::"${actor}"`, action: `Action::"${action}"`, resource: `User::"${target}"`,
      context: { ...(role ? { role } : {}), admin_orgs: adminOrgs.map((o) => ({ __entity: { type: 'Org', id: o } })) }, entities: entitiesFor(h, [target, actor]), audit: { source: 'http', subject: actor, note: `${action} ${target}` } }) });
  if (!res.ok) throw new Error(`core answered ${res.status}`);
  const out = (await res.json()) as { allow?: boolean; reasons?: string[]; errors?: string[] };
  const reasons = [...(out.reasons ?? [])];
  return { allow: out.allow === true, reasons, engine: !(reasons.length === 1 && reasons[0] === 'no-active-version') };
}

/**
 * The roles `actor` may give or take away, decided by the same Cedar rule as the merge gate (assignment:change): a role is offered when the policy allows it for at least one
 * person the actor works with (her reports, the people of her organisations; any known person for a super admin). No parallel list of roles lives in code.
 */
export async function assignableRoleIds(tenant: string, actor: string, roleIds: string[]): Promise<Set<string>> {
  if (!screenAccessOn()) return new Set(roleIds);
  const h = await readHierarchy(tenant);
  const mine = new Set((h.orgsOf.get(actor) ?? []));
  const people = new Set<string>();
  for (const id of h.managerOf.keys()) if (chainOf(h, id).includes(actor)) people.add(id);
  for (const [sub, orgs] of h.orgsOf) if (sub !== actor && orgs.some((o) => mine.has(o))) people.add(sub);
  for (const id of h.managerOf.keys()) if (people.size < 3 && id !== actor) people.add(id);
  const probe = [...people].slice(0, 6);
  const ok = new Set<string>();
  try {
    for (const role of roleIds) for (const p of probe) { const a = await askPerson(tenant, h, actor, 'assignment:change', p, role); if (!a.engine) return new Set(roleIds); if (a.allow) { ok.add(role); break; } }
  } catch { throw new ForbiddenException('the policy engine could not be reached; refused to stay on the safe side'); }
  return ok;
}

/** Throws 403 unless `actor` may `action` on `target` (no-op when screen access is off or before the first activation). */
export async function assertPerson(tenant: string, actor: string, action: PersonAction, target: string, role?: string, h?: Hierarchy): Promise<void> {
  if (!screenAccessOn()) return;
  const hh = h ?? await readHierarchy(tenant);
  let a: ScopeAnswer;
  try { a = await askPerson(tenant, hh, actor, action, target, role); } catch (e) { throw new ForbiddenException(`the policy engine could not be reached (${(e as Error).message}); refused to stay on the safe side`); }
  if (!a.engine || a.allow) return;
  throw new ForbiddenException({ code: 'person-out-of-scope', message: role
    ? `You cannot ${/remove/.test(action) ? 'change' : 'assign or remove'} the role ${role} for ${target}: either ${target} is not one of the people you manage, or the role ${role} can only be given by an administrator.`
    : `${target} is not one of the people you manage.`, target, action, ...(role ? { role } : {}) });
}

/** Keeps the rows whose person the actor may `action` (one decision per person, the same Cedar rule as for the actions). Everything when screen access is off. */
export async function filterPeople<T>(tenant: string, actor: string, action: PersonAction, rows: T[], idOf: (r: T) => string): Promise<T[]> {
  if (!screenAccessOn()) return rows;
  const h = await readHierarchy(tenant);
  const ids = [...new Set(rows.map(idOf))];
  const ok = new Map<string, boolean>();
  try {
    for (let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map(async (id) => { const a = await askPerson(tenant, h, actor, action, id); ok.set(id, !a.engine || a.allow); }));
  } catch { throw new ForbiddenException('the policy engine could not be reached; refused to stay on the safe side'); }
  return rows.filter((r) => ok.get(idOf(r)) === true);
}

/** Super admin = opens a screen no rule names (`unmapped`): only the iam-admin rule matches. Identity and authority fields (manager, department, login) are written by them only. */
export async function assertSuperAdmin(tenant: string, actor: string, what: string): Promise<void> {
  if (!screenAccessOn()) return;
  const { askScreen } = await import('../auth/screen-decision.js');
  let a; try { a = await askScreen(tenant, actor, 'authority-edit'); } catch { throw new ForbiddenException('the policy engine could not be reached; refused to stay on the safe side'); }
  if (!a.engine || a.allow) return;
  throw new ForbiddenException({ code: 'administrator-only', message: `${what} is reserved to an administrator: it changes who reports to whom or where someone works.` });
}
