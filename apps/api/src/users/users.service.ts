import { currentBranch, workspaceMode } from '../workspace/context.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import type { PasswordValidatePayload, PasswordValidateResult } from '../plugins/v1/hooks.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { ModuleRef } from '@nestjs/core';
import { Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException, Optional } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Profiles are business data on Dolt main. Password hashes NEVER enter Dolt or SQL, including history. */
@Injectable()
export class UsersService {
  constructor(private readonly v: VersioningService, @Optional() private readonly modules?: ModuleRef, @Optional() private readonly events?: ApplicationBus) {}
  /** Lazy registry lookup (ModuleRef, no import cycle with PluginsV1Module). Optional only so bare `new UsersService(v)`
   * in low-level specs still works; saving a user without a registry refuses loudly. */
  private async registry(write = false): Promise<PluginRegistry> {
    if (!this.modules) throw new Error('directory.default slot requires the plugin registry (UsersService was built without ModuleRef)');
    if (!workspaceMode()) return this.modules.get(PluginRegistry, { strict: false });
    return this.modules.get(BranchRegistries, { strict: false }).get(currentBranch(write));
  }
  private ready?: Promise<void>;
  async onModuleInit() { if (workspaceMode()) await this.init(); }
  private get path() { return process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'; }
  private async credentials(): Promise<Record<string, { salt: string; hash: string; subject?: string }>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
  }
  /** Salted hashes of previous passwords, per subject, newest first (entry 0 = current). Same storage rule as the
   * credential file: a local JSON file, never Dolt or SQL, mode 0600, written atomically (tmp + rename). Capped at
   * 25 entries per subject (the policy plugin checks at most 1 + historyCount = 25). Same concurrency contract as
   * the credential store: a single API process writes it; no cross-process lock. */
  private get historyPath() { return process.env.IAM_PASSWORD_HISTORY_FILE ?? '/tmp/iam-poc-password-history.json'; }
  private async history(): Promise<Record<string, { salt: string; hash: string; at: number }[]>> {
    try { return JSON.parse(await readFile(this.historyPath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
  }
  private async recordHistory(id: string, salt: string, hash: string) {
    const all = await this.history();
    const list = all[id] ?? [];
    list.unshift({ salt, hash, at: Date.now() });
    all[id] = list.slice(0, 25);
    await mkdir(dirname(this.historyPath), { recursive: true, mode: 0o700 });
    await writeFile(this.historyPath + '.tmp', JSON.stringify(all), { mode: 0o600 }); await rename(this.historyPath + '.tmp', this.historyPath);
  }
  private async passwordHistory(id: string) { return (await this.history())[id] ?? []; }
  /** Change date of the current password, when it was set while the history was active (undefined otherwise). */
  async passwordChangedAt(_tenant: string, id: string) { return (await this.passwordHistory(id))[0]?.at; }
  /** The password policy of the auth.password slot (base or an enabled replacement), checked before ANY password
   * is stored. Falls back to the historical rule (12..128) when the serving plugin predates the hook; a faulted
   * plugin fails closed (the error propagates and the change is refused). */
  async checkPasswordPolicy(tenant: string, id: string, candidate: string, user?: { display_name?: unknown; email?: unknown }): Promise<{ ok: boolean; errors: string[] }> {
    if (typeof candidate !== 'string' || candidate.length > 128) return { ok: false, errors: ['password: at most 128 characters'] };
    const reg = await this.registry(true);
    let declares = false;
    try { const p = reg.resolve(tenant, 'auth.password'); declares = !!p.manifest.hooks?.some((h) => h.name === 'auth.password.validate') && reg.isActive(tenant, p.manifest.id); } catch { declares = false; }
    if (!declares) return candidate.length >= 12 ? { ok: true, errors: [] } : { ok: false, errors: ['password: 12 to 128 characters'] };
    const r = await reg.callSlot<PasswordValidateResult>(tenant, 'auth.password', 'auth.password.validate', { tenant, subject: id, candidate, userInfo: { login: id, displayName: String(user?.display_name ?? ''), email: String(user?.email ?? '') }, history: await this.passwordHistory(id), now: Date.now() } satisfies PasswordValidatePayload);
    return { ok: !!r.result.ok, errors: Array.isArray(r.result.errors) ? r.result.errors.map(String).slice(0, 8) : [] };
  }
  private async password(id: string, password: string, pre?: { salt: string; hash: string }) {
    const all = await this.credentials(), salt = pre?.salt ?? randomBytes(24).toString('hex');
    const revision = randomBytes(20).toString('hex');
    const hash = pre?.hash ?? scryptSync(password, salt, 64).toString('hex');
    all[revision] = { subject:id, salt, hash };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path + '.tmp', JSON.stringify(all), { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
    await this.recordHistory(id, salt, hash);
    return revision;
  }
  init() { return this.ready ??= this.v.lock(async () => {
    await this.v.at('main', async (c) => {
      const [cols] = await c.query('show columns from identities');
      if (!(cols as { Field: string }[]).some(x => x.Field === 'login_enabled')) {
        await c.query('alter table identities add column login_enabled boolean not null default true');
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: login eligibility')");
      }
      if (!(cols as { Field: string }[]).some(x => x.Field === 'email')) {
        await c.query('alter table identities add column email varchar(254) null');
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: e-mail address on the profile')");
      }
      if (!(cols as { Field: string }[]).some(x => x.Field === 'credential_revision')) {
        await c.query('alter table identities add column credential_revision varchar(40)');
        const all = await this.credentials();
        for (const id of ['demo-alice','demo-bob']) {
          const revision = all[id] ? id : await this.password(id,'demo-only-not-a-secret');
          await c.query('update identities set credential_revision=? where id=?',[revision,id]);
        }
        await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m','users: credential revision references (no secrets)')");
      }
    });
  }); }
  async list(ref = currentBranch()) { await this.init(); return this.v.at(ref, async c => {
    const [r] = await c.query('select id, display_name, manager_id, department, email, login_enabled, credential_revision from identities order by id');
    const creds = await this.credentials();
    return (r as Record<string, unknown>[]).map(x => ({ ...x, id: String(x.id), credential_revision: x.credential_revision, login_enabled: !!x.login_enabled, hasCredential: !!creds[String(x.credential_revision)] }));
  }); }
  /** The validation rules are answered by the directory.default slot (plugins/directory/users.mjs); storage stays here. */
  private async validate(tenant: string, b: Record<string, unknown>, create: boolean) {
    const r = (await (await this.registry(true)).callSlot<{ valid: boolean; errors?: string[] }>(tenant, 'directory.default', 'directory.user.validate', { body: b, create })).result;
    if (!r.valid) throw new BadRequestException(r.errors?.join('; ') ?? 'invalid user');
  }
  /** `pre`: a credential hashed earlier (sign-up approval). The plain password is never kept. */
  /** DEMO SEED ONLY (called at start-up with IAM_DEMO_DATA_SEED=1): creates a FICTIONAL account on main when it does not exist. Never overwrites. */
  async seedAccount(a: { id: string; display_name: string; department: string; manager_id: string | null; email: string }, password: string) {
    await this.init();
    return this.v.lock(() => this.v.at('main', async (c) => {
      const [rows] = await c.query('select id from identities where id=?', [a.id]); if ((rows as unknown[]).length) return false;
      const revision = await this.password(a.id, password);
      await c.query('insert into identities (id,display_name,manager_id,department,email,login_enabled,credential_revision) values (?,?,?,?,?,true,?)', [a.id, a.display_name, a.manager_id, a.department, a.email, revision]);
      await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m',?)", [`demo seed: account ${a.id}`]);
      return true;
    }));
  }
  async save(id: string, b: Record<string, unknown>, create: boolean, pre?: { salt: string; hash: string }, tenant = 'acme-demo') {
    const branch = currentBranch(true); await this.validate(tenant, pre ? { ...b, password: 'x'.repeat(12) } : b, create); if (b.id !== undefined && b.id !== id) throw new BadRequestException('user id cannot be changed'); await this.init();
    const save = async (c: import('mysql2/promise').Connection) => {
      const [rows] = await c.query('select * from identities where id=?', [id]); const prev = (rows as Record<string, unknown>[])[0];
      if (create && prev) throw new ConflictException('user already exists'); if (!create && !prev) throw new NotFoundException('unknown user');
      const r = { display_name:'', department:'', manager_id:null, email:null, login_enabled:true, ...prev, ...b };
      if (r.manager_id) { let cur: unknown = r.manager_id; for (let n = 0; cur && n < 100; n++) { if (cur === id) throw new BadRequestException(`${r.manager_id} already reports (directly or not) to ${id}: this would make a loop in the management chain`); const [up] = await c.query('select manager_id from identities where id=?', [cur]); cur = (up as { manager_id: string | null }[])[0]?.manager_id; } const [m] = await c.query('select id from identities where id=?', [r.manager_id]); if (!(m as unknown[]).length || r.manager_id === id) throw new BadRequestException('manager must be another existing user'); }
      if (!pre && typeof b.password === 'string') { const check = await this.checkPasswordPolicy(tenant, id, b.password, r); if (!check.ok) throw new BadRequestException(check.errors.join('; ') || 'the password does not respect the policy'); }
      const revision = pre ? await this.password(id, '', pre) : b.password !== undefined ? await this.password(id, b.password as string) : prev?.credential_revision ?? null;
      await c.query('insert into identities (id,display_name,manager_id,department,email,login_enabled,credential_revision) values (?,?,?,?,?,?,?) on duplicate key update display_name=values(display_name),manager_id=values(manager_id),department=values(department),email=values(email),login_enabled=values(login_enabled),credential_revision=values(credential_revision)', [id,r.display_name,r.manager_id || null,r.department,r.email || null,r.login_enabled,revision]);
      const [dirty] = await c.query("select table_name from dolt_status where table_name='identities'");
      if ((dirty as unknown[]).length) { await c.query("call dolt_add('identities')"); await c.query('call dolt_commit(\'-m\',?)', [`users: ${create ? 'create' : 'update'} ${id}`]); }
    };
    let prev: Record<string, unknown> | undefined;
    const capture = async (c: import('mysql2/promise').Connection) => { const [rows] = await c.query('select * from identities where id=?', [id]); prev = (rows as Record<string, unknown>[])[0]; await save(c); };
    if(workspaceMode()) await this.v.writeOn(branch,capture); else await this.v.lock(()=>this.v.at(branch,capture));
    const saved = (await this.list()).find(x => x.id === id) as Record<string, unknown> | undefined;
    // Application events (workflow start triggers): emitted after the write succeeded, fire-and-forget.
    const at = new Date().toISOString();
    if (create) this.events?.emit({ type: 'user.created', tenant, branch, at, payload: { subject: id, displayName: String(saved?.display_name ?? ''), department: String(saved?.department ?? ''), email: String(saved?.email ?? '') } });
    else if (prev) {
      if (String(prev.department ?? '') !== String(saved?.department ?? '')) this.events?.emit({ type: 'user.department-changed', tenant, branch, at, payload: { subject: id, from: String(prev.department ?? ''), to: String(saved?.department ?? '') } });
      if (!!prev.login_enabled && saved && !saved.login_enabled) this.events?.emit({ type: 'user.disabled', tenant, branch, at, payload: { subject: id } });
    }
    return saved;
  }
  /** Self-service password change (profile Security component): the current password re-authenticates the request. Writes on main, like every live self-service edit. */
  async changePassword(tenant: string, id: string, current: string, next: string) {
    if (typeof next !== 'string' || next.length > 128) throw new BadRequestException('password: at most 128 characters');
    if (!(await this.authenticate(tenant, id, current))) throw new ForbiddenException('the current password does not match');
    const me = (await this.list('main')).find((x) => x.id === id) as { display_name?: unknown; email?: unknown } | undefined;
    const check = await this.checkPasswordPolicy(tenant, id, next, me);
    if (!check.ok) throw new BadRequestException(check.errors.join('; ') || 'the password does not respect the policy');
    await this.init();
    const revision = await this.password(id, next);
    await this.v.lock(() => this.v.at('main', async (c) => {
      await c.query('update identities set credential_revision=? where id=?', [revision, id]);
      const [dirty] = await c.query("select table_name from dolt_status where table_name='identities'");
      if ((dirty as unknown[]).length) { await c.query("call dolt_add('identities')"); await c.query("call dolt_commit('-m',?)", [`users: ${id} changed their password`]); }
    }));
  }
  /** `ref` is the data branch whose directory answers: 'main' for live sign-in, the tested branch for a branch test sign-in (accounts created there exist only there). */
  async authenticate(tenant: string, id: string, password: string, ref = 'main') {
    if (tenant !== 'acme-demo') return false;
    const users = await this.list(ref); if (!users.some(x => x.id === id && x.login_enabled)) return false;
    const s = (await this.credentials())[String(users.find(x => x.id === id)?.credential_revision)]; if (!s || (s.subject !== undefined && s.subject !== id)) return false;
    return timingSafeEqual(Buffer.from(s.hash, 'hex'), scryptSync(password, s.salt, 64));
  }
}
