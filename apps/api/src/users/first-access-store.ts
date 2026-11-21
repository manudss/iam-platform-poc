import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * "Must change the password at first sign-in" state, one record per account: the credential REVISION it applies to and a server-side
 * expiry. It holds no secret and no hash. Local JSON file next to the credential file (never Dolt, so a branch merge or rollback cannot
 * drop or restore it), mode 0600, written atomically, one writer chain. The flag is only in force while its revision is still the
 * account's current credential revision: any other credential (a change, an admin reset) makes the record stale and inert.
 */
export interface FirstAccessRecord { revision: string; expiresAt: number }
export class FirstAccessStore {
  private chain: Promise<unknown> = Promise.resolve();
  private get path() { return process.env.IAM_FIRST_ACCESS_FILE ?? join(dirname(process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'), 'iam-poc-first-access.json'); }
  private key = (tenant: string, id: string) => `${tenant}:${id}`;
  private async load(): Promise<Record<string, FirstAccessRecord>> {
    try { return JSON.parse(await readFile(this.path, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }   // any other error: fail closed (callers treat a throw as "refuse")
  }
  private mutate<T>(fn: (d: Record<string, FirstAccessRecord>) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const d = await this.load(), out = fn(d);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(this.path + '.tmp', JSON.stringify(d), { mode: 0o600 }); await rename(this.path + '.tmp', this.path);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async get(tenant: string, id: string): Promise<FirstAccessRecord | undefined> { return (await this.load())[this.key(tenant, id)]; }
  set(tenant: string, id: string, rec: FirstAccessRecord) {
    if (!rec.revision || !Number.isFinite(rec.expiresAt)) throw new Error('first access record: revision and expiry required');
    return this.mutate((d) => { d[this.key(tenant, id)] = { revision: rec.revision, expiresAt: rec.expiresAt }; });
  }
  /** Clears only the record that still carries `revision` (a newer record is never dropped by a stale caller). */
  clear(tenant: string, id: string, revision: string) {
    return this.mutate((d) => { const k = this.key(tenant, id); if (d[k]?.revision !== revision) return false; delete d[k]; return true; });
  }
}
