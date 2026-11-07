/**
 * scim-connector plugin: SCIM 2.0-LIKE subset (NOT a SCIM server): accepts a ListResponse-shaped body
 * { Resources: [User...] } where each User has userName, displayName, active, roles[{value}] and the
 * enterprise extension (department, manager.value). One import row per (user, role). Inactive users
 * (active=false) and users without roles are skipped and counted. Not supported: /Users endpoints, PATCH,
 * filters, pagination, groups, auth schemes other than this API's token guard.
 *
 * Pure functions only; the core adapter (apps/api/src/connectors/scim.connector.ts) re-exports them.
 */
import { createRequire } from 'node:module';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

const ID = /^[a-z0-9-]{1,32}$/;
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

export function scimToRows(body) {
  const res = body?.Resources;
  if (!Array.isArray(res) || res.length === 0 || res.length > 1000) throw new BadRequestException('Resources must be a non-empty array (max 1000)');
  const rows = []; let skipped = 0;
  res.forEach((u, i) => {
    const at = `Resources[${i}]`;
    if (typeof u !== 'object' || u === null) throw new BadRequestException(`${at}: object expected`);
    const identity = typeof u.userName === 'string' ? u.userName.trim() : '';
    if (!ID.test(identity)) throw new BadRequestException(`${at}: invalid userName`);
    const displayName = typeof u.displayName === 'string' ? u.displayName.trim() : '';
    if (!displayName || displayName.length > 80) throw new BadRequestException(`${at}: invalid displayName`);
    if (u.active === false) { skipped++; return; }
    const ext = u[ENTERPRISE] ?? {};
    const department = typeof ext.department === 'string' ? ext.department.trim() : '';
    if (department.length > 40) throw new BadRequestException(`${at}: department too long`);
    const manager = typeof ext.manager?.value === 'string' && ext.manager.value ? ext.manager.value.trim() : null;
    if (manager !== null && !ID.test(manager)) throw new BadRequestException(`${at}: invalid manager`);
    const roles = Array.isArray(u.roles) ? u.roles : [];
    if (roles.length === 0) { skipped++; return; }
    for (const r of roles) {
      const role = typeof r?.value === 'string' ? r.value.trim() : '';
      if (!ID.test(role)) throw new BadRequestException(`${at}: invalid role`);
      rows.push({ identity, displayName, manager, department, role });
    }
  });
  if (rows.length === 0) throw new BadRequestException('nothing to import (all users inactive or without roles)');
  return { rows, skipped };
}

// No bus hooks: this plugin is a mapping library the core import flow calls.
export default {};
