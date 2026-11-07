/**
 * directory plugin: public sign-up management rules.
 * The rules live in this folder; the core adapter wires the profile schema, the user directory,
 * the mail outbox and the audit bus through `createSignupManager(deps)`.
 *
 * Public sign-up, closed unless an administrator opened it AND applied that setting. A request is only
 * a request: it is kept outside Dolt, needs e-mail confirmation (simulated outbox in this demo) and an
 * administrator's approval, and approval creates a plain account with NO role, NO department, NO manager.
 * Nothing here can grant access.
 *
 * deps = {
 *   signupOpen(tenant) -> boolean            (live configuration only: nothing staged opens the form)
 *   schema(tenant, 'signup', 'live') -> EffectiveField[]
 *   signupValues(tenant, input) -> values    (only fields the live sign-up schema offers)
 *   putWorking(tenant, id, values, actor)    (profile values onto the working branch at approval)
 *   usersList(ref) -> users                  (existing accounts, to refuse duplicates neutrally)
 *   usersSave(id, body, create, pre, tenant) (approval creates the account on the CURRENT working branch)
 *   outboxSend(message)                      (e-mail confirmation; simulated outbox in this demo)
 *   emit(type, tenant, branch, payload)      (durable audit events)
 *   currentBranch() -> string | undefined    (a public request carries no branch; undefined -> main)
 * }
 */
import { createRequire } from 'node:module';
import { randomBytes, scryptSync, createHash } from 'node:crypto';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(process.env.IAM_API_PACKAGE_JSON ?? new URL('../../apps/api/package.json', import.meta.url));
const { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } = require('@nestjs/common');

const ID = /^[a-z0-9-]{1,32}$/, EMAIL = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/;
const NEUTRAL = { status: 'received', message: 'If the request can be accepted, it now waits for e-mail confirmation and administrator approval.' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const MAX_PENDING = 50, PER_IP_HOUR = 5, TTL_MS = 24 * 3600 * 1000;

export function createSignupManager(deps) {
  const pending = new Map(); const hits = new Map();
  const limit = (ip) => {
    const now = Date.now(), h = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (h.length >= PER_IP_HOUR) throw new HttpException('too many requests', 429);
    h.push(now); hits.set(ip, h);
    if (hits.size > 5000) hits.clear();
  };
  const purge = () => { const now = Date.now(); for (const [k, p] of pending) if (now - p.at > TTL_MS) pending.delete(k); };
  const api = {
    // Exposed for tests and operational inspection.
    pending, hits,
    async schema(tenant) {
      if (!(await deps.signupOpen(tenant))) throw new NotFoundException('sign-up is closed');
      const fields = (await deps.schema(tenant, 'signup', 'live')).map((f) => ({ key: f.key, label: f.label, type: f.type, help: f.help, options: f.options, required: !!f.required }));
      return { fields, base: ['id', 'display_name', 'email', 'password'], note: 'Requests are confirmed by e-mail and approved by an administrator. No role is granted by signing up.' };
    },
    async submit(tenant, body, ip) {
      if (!(await deps.signupOpen(tenant))) throw new NotFoundException('sign-up is closed');
      limit(ip); purge();
      const b = body;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['id', 'display_name', 'email', 'password', 'values'].includes(k))) throw new BadRequestException('allowed: id, display_name, email, password, values');
      if (typeof b.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
      if (typeof b.display_name !== 'string' || !b.display_name.trim() || b.display_name.length > 80) throw new BadRequestException('display_name: 1 to 80 characters');
      if (typeof b.email !== 'string' || !EMAIL.test(b.email)) throw new BadRequestException('invalid email address');
      if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 128) throw new BadRequestException('password: 12 to 128 characters');
      const values = await deps.signupValues(tenant, b.values);
      // Neutral answers: a taken id, a pending request and a full queue look exactly like success (no account enumeration).
      const taken = deps.usersList ? (await deps.usersList('main')).some((u) => u.id === b.id || (u.email && u.email.toLowerCase() === b.email.toLowerCase())) : false;
      const dup = [...pending.values()].some((p) => p.id === b.id || p.email.toLowerCase() === b.email.toLowerCase());
      if (taken || dup || pending.size >= MAX_PENDING) return NEUTRAL;
      const token = randomBytes(24).toString('base64url'), salt = randomBytes(24).toString('hex');
      pending.set(b.id, { id: b.id, display_name: b.display_name.trim(), email: b.email, values, salt, hash: scryptSync(b.password, salt, 64).toString('hex'), tokenHash: sha(token), confirmed: false, at: Date.now() });
      await deps.outboxSend?.({ tenant, to: b.email, subject: 'Confirm your sign-up request (demo)', text: `Confirmation code: ${token}`, subjectUser: b.id });
      // A public request carries no working branch; the registration workflow belongs to the live directory.
      const branch = deps.currentBranch() ?? 'main';
      deps.emit('signup.requested', tenant, branch, { subject: b.id, email: b.email });
      return NEUTRAL;
    },
    confirm(_tenant, token) {
      const t = typeof token === 'string' ? sha(token) : '';
      for (const p of pending.values()) if (t && p.tokenHash === t && Date.now() - p.at <= TTL_MS) p.confirmed = true;
      return { status: 'ok', message: 'If the code was valid, the request now waits for administrator approval.' };
    },
    list() { purge(); return { requests: [...pending.values()].map((p) => ({ id: p.id, display_name: p.display_name, email: p.email, values: p.values, confirmed: p.confirmed, at: new Date(p.at).toISOString() })) }; },
    /** Creates a plain account on the CURRENT working branch (live only after Apply). No role is granted, ever. */
    async approve(tenant, id, actor) {
      const p = pending.get(id); if (!p) throw new NotFoundException('unknown request');
      if (!p.confirmed) throw new ConflictException('the e-mail address is not confirmed yet');
      if (!deps.usersSave) throw new ForbiddenException('no directory');
      const user = await deps.usersSave(p.id, { id: p.id, display_name: p.display_name, email: p.email, login_enabled: true }, true, { salt: p.salt, hash: p.hash }, tenant);
      await deps.putWorking(tenant, p.id, p.values, actor);
      pending.delete(id);
      deps.emit('signup.approved', tenant, deps.currentBranch() ?? 'main', { subject: p.id, email: p.email });
      return { approved: true, user, note: 'Created on the working branch with no role. Sign-in works after Apply.' };
    },
    reject(id) { if (!pending.delete(id)) throw new NotFoundException('unknown request'); return { rejected: true }; },
  };
  return api;
}
