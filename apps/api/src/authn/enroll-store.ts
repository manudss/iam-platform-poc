import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Per-user enrollment data of authentication methods: TOTP secrets, PIN verifiers, e-mail addresses.
 * Never stored in Dolt, never versioned, never returned by an API (a TOTP secret or PIN is shown ONCE at provisioning, demo only).
 * Keyed by tenant/user/instance, so two instances of one method type keep separate secrets.
 *
 * PIN: only a salted scrypt hash of the whole PIN is kept (no per-position verifiers, no pepper). A PIN has only 10^n values, so anyone who gets this
 * file can recover it by search; a real product would add a key held in an HSM/KMS or use one-time codes. Demo accounts and fictional PINs only.
 */
/** One enrolled passkey (WebAuthn credential). The public key is not a secret; the private key never leaves the authenticator. */
export interface WebAuthnCred { id: string; publicKey: string; counter: number; transports?: string[]; name?: string; aaguid?: string; deviceType?: string; backedUp?: boolean; createdAt: string }
interface UserRec { totp?: { secret: string; lastStep: number; enrolledAt?: string; lastUsedAt?: string }; pin?: { length: number; salt: string; hash: string; enrolledAt?: string; lastUsedAt?: string }; email?: string; webauthn?: { credentials: WebAuthnCred[]; pending?: { challenge: string; origin: string; rpId: string; exp: number } } }
interface FileShape { users: Record<string, Record<string, UserRec>> }

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
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.data = { users: {} }; }
    return this.data;
  }
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
    return Object.fromEntries(Object.entries(u).map(([inst, r]) => [inst, {
      totp: !!r.totp,
      // Enrolment dates for the profile surfaces ("enrolled on…", "last used…"); records from before this field existed report null.
      totpEnrolledAt: r.totp?.enrolledAt ?? null,
      totpLastUsedAt: r.totp?.lastUsedAt ?? null,
      pin: r.pin ? { length: r.pin.length, enrolledAt: r.pin.enrolledAt ?? null, lastUsedAt: r.pin.lastUsedAt ?? null } : false,
      email: r.email ?? null,
      webauthn: r.webauthn?.credentials?.length ? r.webauthn.credentials.map((c) => ({ id: c.id, name: c.name ?? null, createdAt: c.createdAt, backedUp: !!c.backedUp, deviceType: c.deviceType ?? null })) : false }]))
  }
  /** Counts per method instance and kind (admin overview of who enrolled what; secrets never leave the store). */
  async stats(tenant: string) {
    const d = await this.load();
    const out: Record<string, { totp: number; pin: number; email: number; webauthn: number }> = {};
    for (const [k, insts] of Object.entries(d.users)) {
      if (!k.startsWith(tenant + '/')) continue;
      for (const [inst, r] of Object.entries(insts)) {
        const s = (out[inst] ??= { totp: 0, pin: 0, email: 0, webauthn: 0 });
        if (r.totp) s.totp++; if (r.pin) s.pin++; if (r.email) s.email++; if (r.webauthn?.credentials?.length) s.webauthn++;
      }
    }
    return out;
  }
  async remove(tenant: string, user: string, inst: string) { await this.mutate((d) => { const u = d.users[`${tenant}/${user}`]; if (u) delete u[inst]; }); }

  // TOTP
  async setTotp(tenant: string, user: string, inst: string, secret: string) { await this.mutate((d) => { this.rec(d, tenant, user, inst).totp = { secret, lastStep: -1, enrolledAt: new Date().toISOString() }; }); }
  async totp(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.totp; }
  /** Records the accepted step; refuses a step that was already used (replay). */
  async consumeTotpStep(tenant: string, user: string, inst: string, step: number): Promise<boolean> {
    return this.mutate((d) => { const t = this.get(d, tenant, user, inst)?.totp; if (!t || step <= t.lastStep) return false; t.lastStep = step; t.lastUsedAt = new Date().toISOString(); return true; });
  }

  // PIN
  async setPin(tenant: string, user: string, inst: string, pin: string) {
    if (!/^\d{4,8}$/.test(pin)) throw new Error('PIN must be 4 to 8 digits');
    await this.mutate((d) => {
      const salt = randomBytes(16).toString('hex');
      this.rec(d, tenant, user, inst).pin = { length: pin.length, salt, hash: scryptSync(pin, salt, 32).toString('hex'), enrolledAt: new Date().toISOString() };
    });
  }
  async pinLength(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.pin?.length; }
  /** Read-only snapshots for the method plugins' bus payloads (step 2): the core reads, the plugin decides, the core applies effects. */
  async totpRecord(tenant: string, user: string, inst: string) { const t = this.get(await this.load(), tenant, user, inst)?.totp; return t ? { secret: t.secret, lastStep: t.lastStep ?? -1 } : undefined; }
  async pinRecord(tenant: string, user: string, inst: string) { const p = this.get(await this.load(), tenant, user, inst)?.pin; return p ? { length: p.length, salt: p.salt, hash: p.hash } : undefined; }
  async verifyPinFull(tenant: string, user: string, inst: string, pin: string): Promise<boolean> {
    return this.mutate((d) => {
      const p = this.get(d, tenant, user, inst)?.pin; if (!p || !/^\d{4,8}$/.test(pin)) return false;
      const a = Buffer.from(p.hash, 'hex'), b = scryptSync(pin, p.salt, 32);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (ok) p.lastUsedAt = new Date().toISOString();
      return ok;
    });
  }
  /** Records a successful PIN sign-in (the method plugin verifies from a snapshot; the core applies the effect). */
  async touchPinUsed(tenant: string, user: string, inst: string) { await this.mutate((d) => { const p = this.get(d, tenant, user, inst)?.pin; if (p) p.lastUsedAt = new Date().toISOString(); }); }
  // E-mail address of the recipient for code delivery
  async setEmail(tenant: string, user: string, inst: string, email: string) { await this.mutate((d) => { this.rec(d, tenant, user, inst).email = email; }); }
  async email(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.email; }

  // Passkeys (WebAuthn). The pending enrollment challenge lives a few minutes and is spent at most once.
  async setWebAuthnPending(tenant: string, user: string, inst: string, pending: { challenge: string; origin: string; rpId: string; exp: number }) { await this.mutate((d) => { this.rec(d, tenant, user, inst).webauthn ??= { credentials: [] }; this.rec(d, tenant, user, inst).webauthn!.pending = pending; }); }
  async webAuthnPending(tenant: string, user: string, inst: string) { return this.get(await this.load(), tenant, user, inst)?.webauthn?.pending; }
  async clearWebAuthnPending(tenant: string, user: string, inst: string) { await this.mutate((d) => { const w = this.get(d, tenant, user, inst)?.webauthn; if (w) delete w.pending; }); }
  /** Adds (or replaces, same id) an enrolled credential. Refuses a duplicate id coming from a DIFFERENT key. */
  async addWebAuthnCredential(tenant: string, user: string, inst: string, cred: WebAuthnCred): Promise<boolean> {
    return this.mutate((d) => {
      const w = (this.rec(d, tenant, user, inst).webauthn ??= { credentials: [] });
      const i = w.credentials.findIndex((c) => c.id === cred.id);
      if (i >= 0 && w.credentials[i].publicKey !== cred.publicKey) return false;
      if (i >= 0) w.credentials[i] = { ...w.credentials[i], ...cred }; else w.credentials.push(cred);
      delete w.pending;
      return true;
    });
  }
  async removeWebAuthnCredential(tenant: string, user: string, inst: string, credId: string): Promise<boolean> {
    return this.mutate((d) => {
      const w = this.get(d, tenant, user, inst)?.webauthn; if (!w) return false;
      const n = w.credentials.length; w.credentials = w.credentials.filter((c) => c.id !== credId);
      return w.credentials.length !== n;
    });
  }
  /** Read-only snapshot for the method plugin's bus payload (step 2): the core reads, the plugin decides. */
  async webauthnRecord(tenant: string, user: string, inst: string) {
    const w = this.get(await this.load(), tenant, user, inst)?.webauthn;
    return w?.credentials?.length ? { credentials: w.credentials.map((c) => ({ id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports })) } : undefined;
  }
  /** Anti-clone effect: the counter the plugin accepted is recorded ATOMICALLY, and a regressed counter
   * (a cloned authenticator replaying an old value) refuses the sign-in here. Counters at 0 (most synced
   * passkeys never increment) carry no signal and are not enforced. */
  async advanceWebAuthnCounter(tenant: string, user: string, inst: string, credId: string, counter: number): Promise<boolean> {
    return this.mutate((d) => {
      const c = this.get(d, tenant, user, inst)?.webauthn?.credentials?.find((x) => x.id === credId);
      if (!c) return false;
      if (counter !== 0 && c.counter !== 0 && counter <= c.counter) return false;
      c.counter = Math.max(c.counter, counter);
      return true;
    });
  }
}
