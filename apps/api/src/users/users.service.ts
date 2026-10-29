import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Profiles are business data on Dolt main. Password hashes NEVER enter Dolt or SQL, including history. */
@Injectable()
export class UsersService {
  constructor(private readonly v: VersioningService) {}
  private ready?: Promise<void>;
  private get path() { return process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'; }
  private async credentials(): Promise<Record<string, { salt: string; hash: string }>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
  }
  private async password(id: string, password: string) {
    const all = await this.credentials(), salt = randomBytes(24).toString('hex');
    all[id] = { salt, hash: scryptSync(password, salt, 64).toString('hex') };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path + '.tmp', JSON.stringify(all), { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
  }
  init() { return this.ready ??= this.v.lock(async () => {
    await this.v.at('main', async (c) => {
      const [cols] = await c.query('show columns from identities');
      if (!(cols as { Field: string }[]).some(x => x.Field === 'login_enabled')) {
        await c.query('alter table identities add column login_enabled boolean not null default true');
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: login eligibility')");
      }
    });
    const all = await this.credentials();
    for (const id of ['demo-alice', 'demo-bob']) if (!all[id]) await this.password(id, 'demo-only-not-a-secret');
  }); }
  async list() { await this.init(); return this.v.at('main', async c => {
    const [r] = await c.query('select id, display_name, manager_id, department, login_enabled from identities order by id');
    const creds = await this.credentials();
    return (r as Record<string, unknown>[]).map(x => ({ ...x, id: String(x.id), login_enabled: !!x.login_enabled, hasCredential: !!creds[String(x.id)] }));
  }); }
  private validate(b: Record<string, unknown>, create: boolean) {
    if (create && (typeof b.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(b.id))) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
    for (const [k, max] of [['display_name',80], ['department',40], ['manager_id',32]] as const) if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || (b[k] as string).length > max)) throw new BadRequestException(`invalid ${k}`);
    if (b.login_enabled !== undefined && typeof b.login_enabled !== 'boolean') throw new BadRequestException('login_enabled must be boolean');
    if ((create || b.password !== undefined) && (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128)) throw new BadRequestException('password: 12 to 128 characters');
    if (Object.keys(b).some(k => !['id','display_name','department','manager_id','login_enabled','password'].includes(k))) throw new BadRequestException('unknown user field');
  }
  async save(id: string, b: Record<string, unknown>, create: boolean) {
    this.validate(b, create); if (b.id !== undefined && b.id !== id) throw new BadRequestException('user id cannot be changed'); await this.init();
    await this.v.lock(() => this.v.at('main', async c => {
      const [rows] = await c.query('select * from identities where id=?', [id]); const prev = (rows as Record<string, unknown>[])[0];
      if (create && prev) throw new ConflictException('user already exists'); if (!create && !prev) throw new NotFoundException('unknown user');
      const r = { display_name:'', department:'', manager_id:null, login_enabled:true, ...prev, ...b };
      if (r.manager_id) { const [m] = await c.query('select id from identities where id=?', [r.manager_id]); if (!(m as unknown[]).length || r.manager_id === id) throw new BadRequestException('manager must be another existing user'); }
      if (b.password !== undefined) await this.password(id, b.password as string);
      await c.query('insert into identities (id,display_name,manager_id,department,login_enabled) values (?,?,?,?,?) on duplicate key update display_name=values(display_name),manager_id=values(manager_id),department=values(department),login_enabled=values(login_enabled)', [id,r.display_name,r.manager_id || null,r.department,r.login_enabled]);
      const [dirty] = await c.query("select table_name from dolt_status where table_name='identities'");
      if ((dirty as unknown[]).length) { await c.query("call dolt_add('identities')"); await c.query('call dolt_commit(\'-m\',?)', [`users: ${create ? 'create' : 'update'} ${id}`]); }
    }));
    return (await this.list()).find(x => x.id === id);
  }
  async authenticate(tenant: string, id: string, password: string) {
    if (tenant !== 'acme-demo') return false;
    const users = await this.list(); if (!users.some(x => x.id === id && x.login_enabled)) return false;
    const s = (await this.credentials())[id]; if (!s) return false;
    return timingSafeEqual(Buffer.from(s.hash, 'hex'), scryptSync(password, s.salt, 64));
  }
}
