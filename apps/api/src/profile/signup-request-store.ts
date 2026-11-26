import { ConflictException } from '@nestjs/common';
import { createConnection } from 'mysql2/promise';

export interface SignupQueue { revision: number; requests: Record<string, unknown>[] }
export interface SignupRequestStore {
  load(tenant: string): Promise<SignupQueue>;
  save(tenant: string, expected: number, requests: Record<string, unknown>[]): Promise<void>;
}
export const SIGNUP_REQUEST_STORE = Symbol('SIGNUP_REQUEST_STORE');
export class MemorySignupRequestStore implements SignupRequestStore {
  private rows = new Map<string, SignupQueue>();
  async load(tenant: string) { return structuredClone(this.rows.get(tenant) ?? { revision: 0, requests: [] }); }
  async save(tenant: string, expected: number, requests: Record<string, unknown>[]) {
    if ((this.rows.get(tenant)?.revision ?? 0) !== expected) throw new ConflictException('signup queue changed; read and retry');
    this.rows.set(tenant, structuredClone({ revision: expected + 1, requests }));
  }
}
/** Unversioned operational queue. No passwords or confirmation tokens, only salted password hashes and token hashes.
 * Reads/boot never create or alter storage. CAS prevents stale workers from overwriting a decision.
 */
export class DoltSignupRequestStore implements SignupRequestStore {
  private async open() {
    const database = `${process.env.DOLT_DATABASE ?? 'iam'}_meta`.replace(/[^A-Za-z0-9_]/g, '');
    const c = await createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', connectTimeout: 5000 });
    return { c, database };
  }
  async load(tenant: string): Promise<SignupQueue> {
    const { c, database } = await this.open();
    try {
      const [rows] = await c.query(`select revision, requests from \`${database}\`.signup_requests where tenant = ?`, [tenant]);
      const row = (rows as any[])[0];
      return row ? { revision: Number(row.revision), requests: typeof row.requests === 'string' ? JSON.parse(row.requests) : row.requests } : { revision: 0, requests: [] };
    } catch (e: any) {
      if (['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE'].includes(e.code) || /database not found|table not found/i.test(e.message)) return { revision: 0, requests: [] };
      throw e;
    } finally { await c.end(); }
  }
  async save(tenant: string, expected: number, requests: Record<string, unknown>[]) {
    const { c, database } = await this.open();
    try {
      await c.query(`create database if not exists \`${database}\``);
      await c.query(`create table if not exists \`${database}\`.signup_requests (tenant varchar(32) primary key, revision bigint not null, requests json not null)`);
      const [r] = expected === 0
        ? await c.query(`insert ignore into \`${database}\`.signup_requests (tenant, revision, requests) values (?,1,?)`, [tenant, JSON.stringify(requests)])
        : await c.query(`update \`${database}\`.signup_requests set revision=revision+1, requests=? where tenant=? and revision=?`, [JSON.stringify(requests), tenant, expected]);
      if ((r as any).affectedRows !== 1) throw new ConflictException('signup queue changed; read and retry');
    } finally { await c.end(); }
  }
}
