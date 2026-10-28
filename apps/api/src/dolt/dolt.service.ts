import { Injectable, ConflictException, BadRequestException } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { randomBytes } from 'node:crypto';

export interface Violation { identity: string; roleA: string; roleB: string }
const SOD_SQL = `select a.identity_id as identity, r.role_a as roleA, r.role_b as roleB
  from assignments a join assignments b on a.identity_id = b.identity_id
  join sod_rules r on r.role_a = a.role_id and r.role_b = b.role_id`;
const NAME = /^[a-z0-9-]{1,32}$/;

/**
 * Talks to a real Dolt SQL server. Business data lives in Dolt; NestJS is its only writer.
 * Each operation uses its own connection, so branch checkouts never leak between requests.
 * Changes happen on a branch; nothing reaches main until an explicit merge (and merge never happens with a SoD violation).
 */
@Injectable()
export class DoltService {
  private async conn(): Promise<Connection> {
    return createConnection({
      host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307),
      user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '',
      database: process.env.DOLT_DATABASE ?? 'iam',
    });
  }
  private async violations(c: Connection): Promise<Violation[]> {
    const [rows] = await c.query(SOD_SQL);
    return rows as Violation[];
  }
  private async hash(c: Connection, ref: string): Promise<string> {
    const [rows] = await c.query('select hashof(?) as h', [ref]);
    return (rows as { h: string }[])[0].h;
  }

  async head(): Promise<string> {
    const c = await this.conn();
    try { return await this.hash(c, 'main'); } finally { await c.end(); }
  }

  /** True when the commit is reachable from main (dolt_log on main). */
  async commitExists(hash: string): Promise<boolean> {
    const c = await this.conn();
    try { const [r] = await c.query('select count(*) as n from dolt_log where commit_hash = ?', [hash]); return Number((r as { n: number }[])[0].n) > 0; } finally { await c.end(); }
  }

  /** Data of ONE commit (AS OF), used to build the snapshot the core applies. */
  async snapshotAt(commit: string): Promise<{ assignments: { identity_id: string; role_id: string }[]; sod_rules: { role_a: string; role_b: string }[] }> {
    if (!/^[0-9a-v]{8,64}$/.test(commit)) throw new BadRequestException('invalid commit hash');
    const c = await this.conn();
    try {
      const [a] = await c.query(`select identity_id, role_id from assignments as of '${commit}' order by 1,2`);
      const [r] = await c.query(`select role_a, role_b from sod_rules as of '${commit}' order by 1,2`);
      return { assignments: a as never, sod_rules: r as never };
    } finally { await c.end(); }
  }

  /** Reference tag act-<tenant>-<seq> on the activated commit. Idempotent: an existing tag is left untouched. */
  async tagActivation(tenant: string, seq: number, commit: string): Promise<void> {
    const name = `act-${tenant}-${seq}`;
    if (!/^[a-z0-9-]{1,80}$/.test(name)) throw new BadRequestException('invalid tag name');
    const c = await this.conn();
    try {
      const [t] = await c.query('select count(*) as n from dolt_tags where tag_name = ?', [name]);
      if (Number((t as { n: number }[])[0].n) === 0) await c.query('call dolt_tag(?, ?)', [name, commit]);
    } finally { await c.end(); }
  }

  async assignments(): Promise<{ identity_id: string; role_id: string }[]> {
    const c = await this.conn();
    try { const [r] = await c.query('select identity_id, role_id from assignments order by 1,2'); return r as never; } finally { await c.end(); }
  }

  /** Creates a branch, adds the assignment there, simulates SoD, commits on the branch only. */
  async simulate(identity: string, role: string) {
    if (!NAME.test(identity) || !NAME.test(role)) throw new BadRequestException('invalid identity or role');
    const c = await this.conn();
    try {
      const [ok] = await c.query('select (select count(*) from identities where id = ?) as i, (select count(*) from roles where id = ?) as r', [identity, role]);
      const k = (ok as { i: number; r: number }[])[0];
      if (!k.i || !k.r) throw new BadRequestException('unknown identity or role');
      const branch = `change-${randomBytes(4).toString('hex')}`;
      await c.query('CALL DOLT_CHECKOUT(\'-b\', ?)', [branch]);
      await c.query('INSERT IGNORE INTO assignments VALUES (?, ?)', [identity, role]);
      const violations = await this.violations(c);
      await c.query('CALL DOLT_COMMIT(\'-A\', \'-m\', ?)', [`simulate: ${identity} gets ${role}`]);
      const commit = await this.hash(c, branch);
      await c.query('CALL DOLT_CHECKOUT(\'main\')');
      return { branch, commit, violations, mergeable: violations.length === 0 };
    } finally { await c.end(); }
  }

  /**
   * Connector entry point: upserts identities and role assignments on a NEW branch, simulates SoD, commits on the branch.
   * Like simulate(): nothing reaches main until an explicit merge. Rows are validated before any write.
   */
  async importRows(rows: { identity: string; displayName: string; manager: string | null; department: string; role: string }[]) {
    if (!rows.length || rows.length > 500) throw new BadRequestException('1 to 500 rows expected');
    const c = await this.conn();
    try {
      const [rr] = await c.query('select id from roles');
      const roles = new Set((rr as { id: string }[]).map((r) => r.id));
      const bad = rows.filter((r) => !roles.has(r.role));
      if (bad.length) throw new BadRequestException(`unknown role in rows: ${[...new Set(bad.map((r) => r.role))].slice(0, 5).join(', ')}`);
      const branch = `change-${randomBytes(4).toString('hex')}`;
      await c.query('CALL DOLT_CHECKOUT(\'-b\', ?)', [branch]);
      for (const r of rows) {
        await c.query('INSERT INTO identities (id, display_name, manager_id, department) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), manager_id=VALUES(manager_id), department=VALUES(department)', [r.identity, r.displayName, r.manager, r.department]);
        await c.query('INSERT IGNORE INTO assignments VALUES (?, ?)', [r.identity, r.role]);
      }
      const violations = await this.violations(c);
      await c.query('CALL DOLT_COMMIT(\'-A\', \'-m\', ?)', [`csv import: ${rows.length} rows`]);
      const commit = await this.hash(c, branch);
      await c.query('CALL DOLT_CHECKOUT(\'main\')');
      return { branch, commit, rows: rows.length, violations, mergeable: violations.length === 0 };
    } finally { await c.end(); }
  }

  /** Merges a simulated branch into main, after re-checking SoD on the branch. Returns the new main commit. */
  async merge(branch: string): Promise<{ commit: string }> {
    if (!/^change-[0-9a-f]{8}$/.test(branch)) throw new BadRequestException('invalid branch');
    const c = await this.conn();
    try {
      await c.query('CALL DOLT_CHECKOUT(?)', [branch]);
      const v = await this.violations(c);
      if (v.length) throw new ConflictException({ error: 'SoD violation, merge refused', violations: v });
      await c.query('CALL DOLT_CHECKOUT(\'main\')');
      await c.query('CALL DOLT_MERGE(?)', [branch]);
      return { commit: await this.hash(c, 'main') };
    } finally { await c.end(); }
  }
  // ---- Plugin configuration versioning (non-secret settings and enablement; grants are NOT versioned here: they stay an explicit admin act) ----

  /** Writes one plugin's configuration on a NEW branch and commits it there. Main is untouched until an explicit merge. */
  async proposePluginConfig(tenant: string, plugin: string, cfg: { enabled: boolean; settings: Record<string, unknown> }) {
    if (!NAME.test(tenant) || !/^[a-z0-9-]{1,64}$/.test(plugin)) throw new BadRequestException('invalid tenant or plugin');
    const c = await this.conn();
    try {
      const branch = `change-${randomBytes(4).toString('hex')}`;
      await c.query('CALL DOLT_CHECKOUT(\'-b\', ?)', [branch]);
      await c.query('INSERT INTO plugin_config (tenant, plugin, enabled, settings) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), settings=VALUES(settings)', [tenant, plugin, cfg.enabled, JSON.stringify(cfg.settings)]);
      await c.query('CALL DOLT_COMMIT(\'-A\', \'-m\', ?)', [`plugin config: ${tenant}/${plugin} enabled=${cfg.enabled}`]);
      const commit = await this.hash(c, branch);
      await c.query('CALL DOLT_CHECKOUT(\'main\')');
      return { branch, commit };
    } finally { await c.end(); }
  }

  /** Plugin configuration of one tenant as of a Dolt commit or branch (read only, tenant-scoped). */
  async pluginConfigAt(tenant: string, ref: string): Promise<{ plugin: string; enabled: boolean; settings: Record<string, unknown> }[]> {
    if (!NAME.test(tenant) || !/^([0-9a-v]{32}|main|change-[0-9a-f]{8})$/.test(ref)) throw new BadRequestException('invalid tenant or ref');
    const c = await this.conn();
    try {
      const [rows] = await c.query('select plugin, enabled, settings from plugin_config as of ? where tenant = ? order by plugin', [ref, tenant]);
      return (rows as { plugin: string; enabled: number; settings: unknown }[]).map((r) => ({ plugin: r.plugin, enabled: !!r.enabled, settings: (typeof r.settings === 'string' ? JSON.parse(r.settings) : r.settings) as Record<string, unknown> }));
    } finally { await c.end(); }
  }
}
