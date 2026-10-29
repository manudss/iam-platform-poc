import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Per-user enrollment data of authentication methods: TOTP secrets, PIN verifiers, e-mail addresses.
 * Never stored in Dolt, never versioned, never returned by an API (a TOTP secret or PIN is shown ONCE at provisioning, demo only).
 * Keyed by tenant/user/instance, so two instances of one method type keep separate secrets.
 *
 * PIN: a full check needs a slow salted hash (scrypt). A bank-style "digits 2, 5 and 6" check cannot be done from that hash, so a
 * per-position verifier is kept too: HMAC-SHA-256(pepper, position, digit). A PIN has only 10^n values, so anyone who gets this file AND
 * the pepper can recover it by search. This is the documented limit of the POC; a real product would encrypt the PIN with a key held in an HSM/KMS.
 */
interface UserRec { totp?: { secret: string; lastStep: number }; pin?: { length: number; salt: string; hash: string; pos: string[] }; email?: string }
interface FileShape { pepper: string; users: Record<string, Record<string, UserRec>> }

export function defaultEnrollmentPath() {
  return process.env.IAM_AUTHN_FILE ?? join(dirname(process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'), 'iam-poc-authn-enrollments.json');
}

export class EnrollmentStore {
  private data?: FileShape;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path = defaultEnrollmentPath()) {}

  private async load(): Promise<FileShape> {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')) as FileShape; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.data = { pepper: randomBytes(32).toString('hex'), users: {} }; }
    return this.data;
  }
  private pepper(d: FileShape) { return process.env.IAM_AUTHN_PEPPER && process.env.IAM_AUTHN_PEPPER.length >= 16 ? process.env.IAM_AUTHN_PEPPER : d.pepper; }
  private async save() {
    const d = this.data!;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path + '.tmp', JSON.stringify(d), { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
  }
  /** Serialize read-modify-write cycles. */
  private mutate<T>(fn: (d: FileShape) => T): Promise<T> {
    const run = this.chain.then(async () => { const d = await this.load(); const r = fn(d); await this.save(); return r; });
    this.chain = run.catch(() => undefined); return run;
  }
  private rec(d: FileShape, tenant: string, user: string, inst: string): UserRec { return ((d.users[`${tenant}/${user}`] ??= {})[inst] ??= {}); }
  private get(d: FileShape, tenant: string, user: string, inst: string): UserRec | undefined { return d.users[`${tenant}/${user}`]?.[inst]; }

  async status(tenant: string, user: string) {
    const d = await this.load(); const u = d.users[`${tenant}/${user}`] ?? {};
    return Object.fromEntries(Object.entries(u).map(([inst, r]) => [inst, { totp: !!r.totp, pin: r.pin ? { length: r.pin.length } : false, email: r.email ?? null }]));
  }
  async remove(tenant: string, user: string, inst: string) { await this.mutate((d) => { const u = d.users[`${tenant}/${user}`]; if (u) delete u[inst]; }); }

  // TOTP
  async setTotp(tenant: string, user: string, inst: string, secret: string) { await this.mutate((d) => { this.rec(d, tenant, user, inst).totp = { secret, lastStep: -1 }; }); }
  async totp(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.totp; }
  /** Records the accepted step; refuses a step that was already used (replay). */
  async consumeTotpStep(tenant: string, user: string, inst: string, step: number): Promise<boolean> {
    return this.mutate((d) => { const t = this.get(d, tenant, user, inst)?.totp; if (!t || step <= t.lastStep) return false; t.lastStep = step; return true; });
  }

  // PIN
  async setPin(tenant: string, user: string, inst: string, pin: string) {
    if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4 to 8 digits');
    await this.mutate((d) => {
      const salt = randomBytes(16).toString('hex');
      this.rec(d, tenant, user, inst).pin = { length: pin.length, salt, hash: scryptSync(pin, salt, 32).toString('hex'), pos: [...pin].map((dg, i) => this.posMac(d, tenant, user, inst, i, dg)) };
    });
  }
  private posMac(d: FileShape, tenant: string, user: string, inst: string, i: number, digit: string) {
    return createHmac('sha256', this.pepper(d)).update(`${tenant}/${user}/${inst}/${i}/${digit}`).digest('hex');
  }
  async pinLength(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.pin?.length; }
  async verifyPinFull(tenant: string, user: string, inst: string, pin: string): Promise<boolean> {
    const p = this.get(await this.load(), tenant, user, inst)?.pin; if (!p || !/^\d{4,8}$/.test(pin)) return false;
    const a = Buffer.from(p.hash, 'hex'), b = scryptSync(pin, p.salt, 32); return a.length === b.length && timingSafeEqual(a, b);
  }
  async verifyPinPositions(tenant: string, user: string, inst: string, answers: Record<number, string>): Promise<boolean> {
    const d = await this.load(), p = this.get(d, tenant, user, inst)?.pin; if (!p) return false;
    let ok = true;
    for (const [k, digit] of Object.entries(answers)) {
      const i = Number(k); if (!Number.isInteger(i) || i < 0 || i >= p.length || !/^\d$/.test(digit)) { ok = false; continue; }
      const a = Buffer.from(p.pos[i], 'hex'), b = Buffer.from(this.posMac(d, tenant, user, inst, i, digit), 'hex');
      if (!timingSafeEqual(a, b)) ok = false;
    }
    return ok && Object.keys(answers).length > 0;
  }

  // E-mail address of the recipient for code delivery
  async setEmail(tenant: string, user: string, inst: string, email: string) { await this.mutate((d) => { this.rec(d, tenant, user, inst).email = email; }); }
  async email(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.email; }
}
