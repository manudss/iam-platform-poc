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

/** The dedicated right to manage blocks. It is a permission of its own, assigned to roles (admin and manager for now), not a rule hard-wired to a role. */
export const MANAGE_BLOCKS_RIGHT = 'accounts.blocks.manage';
export interface Actor { subject: string; /** Whether the actor holds MANAGE_BLOCKS_RIGHT through one of their roles. */ mayManageBlocks: boolean }
export type Refusal = 'self' | 'not-allowed' | 'last-admin';
export interface Target { subject: string; admin: boolean }

/**
 * Who may set or lift a block. Kept simple on purpose: whoever holds the right may block or unblock anyone else, whatever set the block.
 * Two protections stay: nobody blocks themselves, and the last active administrator cannot be blocked.
 */
export function mayManage(a: { actor: Actor; target: Target; kind: BlockKind; action: 'block' | 'unblock'; activeAdmins: readonly string[] }): { ok: true } | { ok: false; reason: Refusal } {
  const { actor, target, action, activeAdmins } = a;
  if (action === 'block' && actor.subject === target.subject) return { ok: false, reason: 'self' };
  if (!actor.mayManageBlocks) return { ok: false, reason: 'not-allowed' };
  if (action === 'block' && target.admin && activeAdmins.length === 1 && activeAdmins[0] === target.subject) return { ok: false, reason: 'last-admin' };
  return { ok: true };
}

/** A change set (for example a branch about to be applied) must not lock out whoever applies it, nor the last admin. */
export function lockoutAfter(a: { applier: string; adminsBefore: readonly string[]; blockedAfter: ReadonlySet<string> }): { ok: true } | { ok: false; reason: 'applier-blocked' | 'no-admin-left' } {
  if (a.blockedAfter.has(a.applier)) return { ok: false, reason: 'applier-blocked' };
  if (a.adminsBefore.length && a.adminsBefore.every((s) => a.blockedAfter.has(s))) return { ok: false, reason: 'no-admin-left' };
  return { ok: true };
}

/** Lockout settings. The owner chose the starting values (5 failures in 15 minutes, locked 15 minutes) and wants them on; every field stays configurable per tenant. */
export interface LockoutSettings { enabled: boolean; maxFailures: number; windowMs: number; lockMs: number; hold: boolean; exempt: readonly string[] }
export const LOCKOUT_DEFAULT: LockoutSettings = { enabled: true, maxFailures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000, hold: false, exempt: [] };

/** Failed attempts inside the window decide whether a lock block must be set now. Pure: the caller keeps the timestamps. */
export function lockoutVerdict(failures: readonly number[], now: number, s: LockoutSettings, subject: string): { lock: boolean; recent: number } {
  const recent = failures.filter((t) => now - t < s.windowMs).length;
  if (!s.enabled || s.exempt.includes(subject)) return { lock: false, recent };
  return { lock: recent >= s.maxFailures, recent };
}

/** The sign-in refusal shown for a block: its type, the message set by whoever blocked, and a short reference for support. */
export const BLOCK_LABEL: Record<BlockKind, string> = {
  suspended: 'Account suspended', disabled: 'Account disabled', locked: 'Account locked after too many failed attempts',
  pending_approval: 'Account waiting for approval', pending_verification: 'E-mail address not verified yet',
};
export const blockReference = (b: Pick<Block, 'id'>) => `BLK-${b.id.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase()}`;
export function refusalMessage(b: Block): string { return `${BLOCK_LABEL[b.kind]}. ${b.message.trim()} Reference ${blockReference(b)}.`.replace(/\.\s*\./g, '.'); }

export const LOCKOUT_OFF: LockoutSettings = { ...LOCKOUT_DEFAULT, enabled: false };
