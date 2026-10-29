import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { UsersService } from '../users/users.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { ProfileService } from './profile.service.js';

interface Pending { id: string; display_name: string; email: string; values: Record<string, string | number | boolean | null>; salt: string; hash: string; tokenHash: string; confirmed: boolean; at: number }
const ID = /^[a-z0-9-]{1,32}$/, EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/;
const NEUTRAL = { status: 'received', message: 'If the request can be accepted, it now waits for e-mail confirmation and administrator approval.' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Public sign-up, closed unless an administrator opened it AND applied that setting. A request is only a request:
 * it is kept outside Dolt, needs e-mail confirmation (simulated outbox in this demo) and an administrator's approval,
 * and approval creates a plain account with NO role, NO department, NO manager. Nothing here can grant access.
 */
@Injectable()
export class SignupService {
  private pending = new Map<string, Pending>();
  private hits = new Map<string, number[]>();
  static MAX_PENDING = 50; static PER_IP_HOUR = 5; static TTL_MS = 24 * 3600 * 1000;
  constructor(private readonly profile: ProfileService, @Optional() private readonly users?: UsersService, @Optional() private readonly authn?: AuthnService) {}

  private limit(ip: string) {
    const now = Date.now(), h = (this.hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (h.length >= SignupService.PER_IP_HOUR) throw new HttpException('too many requests', 429);
    h.push(now); this.hits.set(ip, h);
    if (this.hits.size > 5000) this.hits.clear();
  }
  private purge() { const now = Date.now(); for (const [k, p] of this.pending) if (now - p.at > SignupService.TTL_MS) this.pending.delete(k); }

  async schema(tenant: string) {
    if (!(await this.profile.signupOpen(tenant))) throw new NotFoundException('sign-up is closed');
    const fields = (await this.profile.schema(tenant, 'signup', 'live')).map((f) => ({ key: f.key, label: f.label, type: f.type, help: f.help, options: f.options, required: !!f.required }));
    return { fields, base: ['id', 'display_name', 'email', 'password'], note: 'Requests are confirmed by e-mail and approved by an administrator. No role is granted by signing up.' };
  }

  async submit(tenant: string, body: unknown, ip: string) {
    if (!(await this.profile.signupOpen(tenant))) throw new NotFoundException('sign-up is closed');
    this.limit(ip); this.purge();
    const b = body as Record<string, unknown>;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['id', 'display_name', 'email', 'password', 'values'].includes(k))) throw new BadRequestException('allowed: id, display_name, email, password, values');
    if (typeof b.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
    if (typeof b.display_name !== 'string' || !b.display_name.trim() || b.display_name.length > 80) throw new BadRequestException('display_name: 1 to 80 characters');
    if (typeof b.email !== 'string' || !EMAIL.test(b.email)) throw new BadRequestException('invalid email address');
    if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128) throw new BadRequestException('password: 12 to 128 characters');
    const values = await this.profile.signupValues(tenant, b.values);
    // Neutral answers: a taken id, a pending request and a full queue look exactly like success (no account enumeration).
    const taken = this.users ? (await this.users.list('main') as { id: string; email?: string | null }[]).some((u) => u.id === b.id || (u.email && u.email.toLowerCase() === (b.email as string).toLowerCase())) : false;
    const dup = [...this.pending.values()].some((p) => p.id === b.id || p.email.toLowerCase() === (b.email as string).toLowerCase());
    if (taken || dup || this.pending.size >= SignupService.MAX_PENDING) return NEUTRAL;
    const token = randomBytes(24).toString('base64url'), salt = randomBytes(24).toString('hex');
    this.pending.set(b.id, { id: b.id, display_name: b.display_name.trim(), email: b.email, values, salt, hash: scryptSync(b.password, salt, 64).toString('hex'), tokenHash: sha(token), confirmed: false, at: Date.now() });
    await this.authn?.outbox.send({ tenant, to: b.email, subject: 'Confirm your sign-up request (demo)', text: `Confirmation code: ${token}`, subjectUser: b.id });
    return NEUTRAL;
  }

  confirm(tenant: string, token: unknown) {
    const t = typeof token === 'string' ? sha(token) : '';
    for (const p of this.pending.values()) if (t && p.tokenHash === t && Date.now() - p.at <= SignupService.TTL_MS) p.confirmed = true;
    return { status: 'ok', message: 'If the code was valid, the request now waits for administrator approval.' };
  }

  list() { this.purge(); return { requests: [...this.pending.values()].map((p) => ({ id: p.id, display_name: p.display_name, email: p.email, values: p.values, confirmed: p.confirmed, at: new Date(p.at).toISOString() })) }; }

  /** Creates a plain account on the CURRENT working branch (live only after Apply). No role is granted, ever. */
  async approve(tenant: string, id: string, actor: string) {
    const p = this.pending.get(id); if (!p) throw new NotFoundException('unknown request');
    if (!p.confirmed) throw new ConflictException('the e-mail address is not confirmed yet');
    if (!this.users) throw new ForbiddenException('no directory');
    const user = await this.users.save(p.id, { id: p.id, display_name: p.display_name, email: p.email, login_enabled: true }, true, { salt: p.salt, hash: p.hash });
    await this.profile.putWorking(tenant, p.id, p.values, actor);
    this.pending.delete(id);
    return { approved: true, user, note: 'Created on the working branch with no role. Sign-in works after Apply.' };
  }
  reject(id: string) { if (!this.pending.delete(id)) throw new NotFoundException('unknown request'); return { rejected: true }; }
}
