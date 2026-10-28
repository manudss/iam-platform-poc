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
}
