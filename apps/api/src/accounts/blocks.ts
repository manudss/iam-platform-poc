/**
 * Account blocks: the pure rules (no storage, no I/O). An account may carry several blocks at once; it can sign in only
 * when none is in force. Storage, the sign-in gate and the admin API call these functions so the rules live in one place.
 */
export const BLOCK_KINDS = ['suspended', 'disabled', 'locked', 'pending_approval', 'pending_verification'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export type BlockOrigin = 'admin' | 'manager' | 'workflow' | 'automatic';

export interface Block {
  id: string;
  subject: string;
  kind: BlockKind;
  /** Shown to the person when sign-in is refused because of this block. */
  message: string;
  origin: BlockOrigin;
  setBy: string;
  setAt: number;
  /** Epoch ms. After this instant the block no longer applies. Absent: no automatic end. */
  until?: number;
  /** Keep the block until an admin or a workflow lifts it: `until` is ignored. */
  hold?: boolean;
}

/** Order in which one block is shown when several apply (first = shown). */
export const BLOCK_PRIORITY: readonly BlockKind[] = BLOCK_KINDS;

/** Blocks in force at `now`: a held block never expires, a timed one stops at `until`. */
export function inForce(blocks: readonly Block[], now: number): Block[] {
  return blocks.filter((b) => b.hold || b.until === undefined || b.until > now);
}

export function canSignIn(blocks: readonly Block[], now: number): boolean {
  return inForce(blocks, now).length === 0;
}

/** The single block to show the person: highest priority first, then the oldest. Undefined when none applies. */
export function shownBlock(blocks: readonly Block[], now: number): Block | undefined {
  return [...inForce(blocks, now)].sort((a, b) => BLOCK_PRIORITY.indexOf(a.kind) - BLOCK_PRIORITY.indexOf(b.kind) || a.setAt - b.setAt)[0];
}

/** Lifting one block never touches the others. */
export function lift(blocks: readonly Block[], blockId: string): Block[] { return blocks.filter((b) => b.id !== blockId); }

/** After the e-mail is verified: the verification block goes; with `holdAfterVerification` an approval block replaces it. */
export function afterVerification(blocks: readonly Block[], opts: { holdAfterVerification: boolean; subject: string; now: number; id: string; message: string }): Block[] {
  const rest = blocks.filter((b) => b.kind !== 'pending_verification');
  if (!opts.holdAfterVerification || rest.some((b) => b.kind === 'pending_approval')) return rest;
  return [...rest, { id: opts.id, subject: opts.subject, kind: 'pending_approval', message: opts.message, origin: 'automatic', setBy: 'system', setAt: opts.now, hold: true }];
}

export interface Actor { subject: string; admin: boolean; /** Subjects this actor manages, directly or not. */ reports: readonly string[] }
export type Refusal = 'self' | 'not-allowed' | 'last-admin' | 'manager-cannot-block-admin' | 'kind-needs-admin';
export interface Target { subject: string; admin: boolean }

/** Kinds a manager may set or lift. `disabled` and the automatic kinds stay with admins (to be confirmed by the owner). */
const MANAGER_KINDS: readonly BlockKind[] = ['suspended'];

/**
 * May `actor` block (`action: 'block'`) or lift (`'unblock'`) a block of `kind` on `target`?
 * Nobody blocks themselves. An admin may act on anyone else, except that the last active admin cannot be blocked.
 * A manager acts only on people who report to them, never on an admin. Unblocking someone else is never refused for a rule other than scope.
 */
export function mayManage(a: { actor: Actor; target: Target; kind: BlockKind; action: 'block' | 'unblock'; activeAdmins: readonly string[] }): { ok: true } | { ok: false; reason: Refusal } {
  const { actor, target, kind, action, activeAdmins } = a;
  if (action === 'block' && actor.subject === target.subject) return { ok: false, reason: 'self' };
  if (actor.admin) {
    if (action === 'block' && target.admin && activeAdmins.length === 1 && activeAdmins[0] === target.subject) return { ok: false, reason: 'last-admin' };
    return { ok: true };
  }
  if (target.admin) return { ok: false, reason: 'manager-cannot-block-admin' };
  if (!actor.reports.includes(target.subject)) return { ok: false, reason: 'not-allowed' };
  if (!MANAGER_KINDS.includes(kind) && kind !== 'pending_approval' && kind !== 'pending_verification' && kind !== 'locked') return { ok: false, reason: 'kind-needs-admin' };
  if (action === 'block' && !MANAGER_KINDS.includes(kind)) return { ok: false, reason: 'kind-needs-admin' };
  return { ok: true };
}

/** A change set (for example a branch about to be applied) must not lock out whoever applies it, nor the last admin. */
export function lockoutAfter(a: { applier: string; adminsBefore: readonly string[]; blockedAfter: ReadonlySet<string> }): { ok: true } | { ok: false; reason: 'applier-blocked' | 'no-admin-left' } {
  if (a.blockedAfter.has(a.applier)) return { ok: false, reason: 'applier-blocked' };
  if (a.adminsBefore.length && a.adminsBefore.every((s) => a.blockedAfter.has(s))) return { ok: false, reason: 'no-admin-left' };
  return { ok: true };
}

/** Lockout settings: OFF unless the owner enables it. No default values are active. */
export interface LockoutSettings { enabled: boolean; maxFailures: number; windowMs: number; lockMs: number; hold: boolean; exempt: readonly string[] }
export const LOCKOUT_OFF: LockoutSettings = { enabled: false, maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, hold: false, exempt: [] };

/** Failed attempts inside the window decide whether a lock block must be set now. Pure: the caller keeps the timestamps. */
export function lockoutVerdict(failures: readonly number[], now: number, s: LockoutSettings, subject: string): { lock: boolean; recent: number } {
  const recent = failures.filter((t) => now - t < s.windowMs).length;
  if (!s.enabled || s.exempt.includes(subject)) return { lock: false, recent };
  return { lock: recent >= s.maxFailures, recent };
}
