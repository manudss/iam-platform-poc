import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Block, type LockoutSettings, LOCKOUT_DEFAULT } from './blocks.js';

/**
 * Account blocks and the automatic-lock settings. Operational security state (an admin unlock or a verification must not be undone by an old branch or a rebase): not in Dolt (a failed sign-in must not make a versioned commit),
 * never returned with secrets. One file, written atomically, like the authentication enrolments. Nothing here is a default value that
 * is active: lockout stays OFF until an administrator enables it.
 */
interface Shape { blocks: Record<string, Block[]>; lockout: Record<string, LockoutSettings>; holdAfterVerification: Record<string, boolean> }

export function defaultBlocksPath() {
  return process.env.IAM_BLOCKS_FILE ?? join(dirname(process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'), 'iam-poc-account-blocks.json');
}

export class BlockStore {
  private data?: Shape;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path = defaultBlocksPath()) {}
  private async load(): Promise<Shape> {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')) as Shape; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.data = { blocks: {}, lockout: {}, holdAfterVerification: {} }; }
    this.data.blocks ??= {}; this.data.lockout ??= {}; this.data.holdAfterVerification ??= {};
    return this.data;
  }
  private mutate<T>(fn: (d: Shape) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const d = await this.load(); const r = fn(d);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', JSON.stringify(d), { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
      return r;
    });
    this.chain = run.catch(() => undefined); return run;
  }
  private key = (tenant: string, subject: string) => `${tenant}/${subject}`;

  async list(tenant: string, subject: string): Promise<Block[]> { return [...((await this.load()).blocks[this.key(tenant, subject)] ?? [])]; }
  /** Adds a block. A second block of the same kind on the same account replaces the first (one lock, one suspension at a time). */
  async add(tenant: string, b: Omit<Block, 'id' | 'subject'> & { subject: string; id?: string }): Promise<Block> {
    const block: Block = { ...b, id: b.id ?? randomBytes(8).toString('hex') };
    await this.mutate((d) => { const k = this.key(tenant, block.subject); d.blocks[k] = [...(d.blocks[k] ?? []).filter((x) => x.kind !== block.kind), block]; });
    return block;
  }
  async lift(tenant: string, subject: string, blockId: string): Promise<boolean> {
    return this.mutate((d) => { const k = this.key(tenant, subject), before = d.blocks[k] ?? []; d.blocks[k] = before.filter((x) => x.id !== blockId); if (!d.blocks[k].length) delete d.blocks[k]; return d.blocks[k]?.length !== before.length; });
  }
  async replace(tenant: string, subject: string, blocks: readonly Block[]): Promise<void> {
    await this.mutate((d) => { const k = this.key(tenant, subject); if (blocks.length) d.blocks[k] = [...blocks]; else delete d.blocks[k]; });
  }
  /** Every account that carries at least one block (admin list). */
  async blocked(tenant: string): Promise<string[]> { return Object.keys((await this.load()).blocks).filter((k) => k.startsWith(`${tenant}/`)).map((k) => k.slice(tenant.length + 1)); }

  async lockout(tenant: string): Promise<LockoutSettings> { return { ...LOCKOUT_DEFAULT, ...((await this.load()).lockout[tenant] ?? {}) }; }
  async setLockout(tenant: string, s: LockoutSettings): Promise<void> { await this.mutate((d) => { d.lockout[tenant] = s; }); }
  async holdAfterVerification(tenant: string): Promise<boolean> { return (await this.load()).holdAfterVerification[tenant] === true; }
  async setHoldAfterVerification(tenant: string, v: boolean): Promise<void> { await this.mutate((d) => { d.holdAfterVerification[tenant] = v; }); }
}
