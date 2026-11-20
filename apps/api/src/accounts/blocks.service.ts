import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Block, type BlockKind, BLOCK_KINDS, inForce, mayManage } from './blocks.js';
import type { BlockStore } from './block-store.js';

/** Kinds a person can set by hand. `pending_verification` belongs to the sign-up flow. */
export const MANUAL_KINDS: readonly BlockKind[] = ['suspended', 'disabled', 'locked', 'pending_approval'];
export const MESSAGE_MAX = 300;
export type Emit = (e: { type: 'user.blocked' | 'user.unblocked'; tenant: string; at: string; payload: Record<string, string> }) => void;

/**
 * Setting and lifting blocks by a person. Whoever reaches this has already passed the guard that checks the dedicated
 * right (screen `account-blocks`); here stay the two protections that no right overrides: nobody blocks themselves, and
 * the last active administrator is never blocked. Lifting needs only the right, whatever set the block.
 */
export class BlocksService {
  constructor(private readonly store: BlockStore, private readonly emit: Emit = () => undefined, private readonly now = () => Date.now()) {}

  list(tenant: string) { return this.store.blocked(tenant).then(async (subs) => Promise.all(subs.map(async (s) => ({ subject: s, blocks: await this.store.list(tenant, s) })))); }

  async block(a: { tenant: string; actor: string; subject: string; kind: string; message: string; until?: number; hold?: boolean; admins: readonly string[] }): Promise<Block> {
    if (!MANUAL_KINDS.includes(a.kind as BlockKind)) throw new BadRequestException(`kind: one of ${MANUAL_KINDS.join(', ')}`);
    const message = String(a.message ?? '').trim();
    if (!message || message.length > MESSAGE_MAX) throw new BadRequestException(`message: 1 to ${MESSAGE_MAX} characters, shown to the person when they sign in`);
    if (a.until !== undefined && (!Number.isFinite(a.until) || a.until <= this.now())) throw new BadRequestException('until: a future time');
    if (!a.subject) throw new BadRequestException('subject required');
    const kind = a.kind as BlockKind;
    const verdict = mayManage({ actor: { subject: a.actor, mayManageBlocks: true }, target: { subject: a.subject, admin: a.admins.includes(a.subject) }, kind, action: 'block', activeAdmins: await this.activeAdminsOf(a.tenant, a.admins) });
    if (!verdict.ok) throw new ForbiddenException({ code: `block-${verdict.reason}`, message: REFUSALS[verdict.reason] });
    const block = await this.store.add(a.tenant, { subject: a.subject, kind, message, origin: 'admin', setBy: a.actor, setAt: this.now(), ...(a.hold ? { hold: true } : a.until ? { until: a.until } : {}), id: randomBytes(8).toString('hex') });
    this.emit({ type: 'user.blocked', tenant: a.tenant, at: new Date(this.now()).toISOString(), payload: { subject: a.subject, kind, actor: a.actor } });
    return block;
  }

  async unblock(a: { tenant: string; actor: string; subject: string; blockId: string }): Promise<void> {
    const before = await this.store.list(a.tenant, a.subject);
    const b = before.find((x) => x.id === a.blockId);
    if (!b) throw new NotFoundException('no such block on this account');
    await this.store.lift(a.tenant, a.subject, a.blockId);
    this.emit({ type: 'user.unblocked', tenant: a.tenant, at: new Date(this.now()).toISOString(), payload: { subject: a.subject, kind: b.kind, actor: a.actor } });
  }

  /** Administrators who can still sign in: the list of administrators minus those carrying a block in force. */
  async activeAdminsOf(tenant: string, admins: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const s of admins) if (!inForce(await this.store.list(tenant, s), this.now()).length) out.push(s);
    return out;
  }
}
const REFUSALS = { self: 'You cannot block your own account.', 'not-allowed': 'You do not have the right to manage blocks.', 'last-admin': 'The last active administrator cannot be blocked.' } as const;
export { BLOCK_KINDS };
