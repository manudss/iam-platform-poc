import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Where a plugin setting of type 'secret' (a provider clientSecret, an API key) lives at rest.
 * Never Dolt, never versioned, never returned by an API, never in an export or an audit line.
 * - OpenBao (Vault-compatible KV v2, the same service the app connectors use) when IAM_BAO_ADDR + IAM_BAO_TOKEN are set.
 * - Otherwise a local file next to the enrollment/credential files, written 0600: the demo's at-rest story,
 *   same storage class as the TOTP/PIN enrollment records. A deployment with real secrets runs OpenBao.
 */
export interface PluginSecretStore {
  get(tenant: string, pluginId: string, key: string): Promise<string | undefined>;
  put(tenant: string, pluginId: string, key: string, value: string): Promise<void>;
}

export function defaultPluginSecretsPath(): string {
  return process.env.IAM_PLUGIN_SECRETS_FILE ?? join(dirname(process.env.IAM_CREDENTIAL_FILE ?? '/tmp/iam-poc-credentials.json'), 'iam-poc-plugin-secrets.json');
}

export function defaultPluginSecrets(): PluginSecretStore {
  return process.env.IAM_BAO_ADDR && process.env.IAM_BAO_TOKEN ? new BaoPluginSecrets() : new FilePluginSecrets();
}

type FileShape = { tenants: Record<string, Record<string, Record<string, string>>> };

export class FilePluginSecrets implements PluginSecretStore {
  private data?: FileShape;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly path = defaultPluginSecretsPath()) {}

  private async load(): Promise<FileShape> {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')) as FileShape; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.data = { tenants: {} }; }
    return this.data;
  }
  private async save() {
    const d = this.data!;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path + '.tmp', JSON.stringify(d), { mode: 0o600 });
    await rename(this.path + '.tmp', this.path);
  }
  private queued<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  get(tenant: string, pluginId: string, key: string): Promise<string | undefined> {
    return this.queued(async () => (await this.load()).tenants[tenant]?.[pluginId]?.[key]);
  }
  put(tenant: string, pluginId: string, key: string, value: string): Promise<void> {
    return this.queued(async () => {
      const d = await this.load();
      ((d.tenants[tenant] ??= {})[pluginId] ??= {})[key] = value;
      await this.save();
    });
  }
}

/** OpenBao KV v2: one secret per tenant/plugin at secret/data/iam/plugins/<tenant>/<pluginId>, keys are setting keys. */
export class BaoPluginSecrets implements PluginSecretStore {
  private get addr() { return process.env.IAM_BAO_ADDR!; }
  private get token() { return process.env.IAM_BAO_TOKEN!; }
  private path(tenant: string, pluginId: string) { return `iam/plugins/${encodeURIComponent(tenant)}/${encodeURIComponent(pluginId)}`; }

  async put(tenant: string, pluginId: string, key: string, value: string): Promise<void> {
    const cur = (await this.getAll(tenant, pluginId)) ?? {};
    cur[key] = value;
    const r = await fetch(`${this.addr}/v1/secret/data/${this.path(tenant, pluginId)}`, {
      method: 'POST', headers: { 'X-Vault-Token': this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: cur }), signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`secret store write failed (${r.status})`);
  }
  async get(tenant: string, pluginId: string, key: string): Promise<string | undefined> {
    return (await this.getAll(tenant, pluginId))?.[key];
  }
  private async getAll(tenant: string, pluginId: string): Promise<Record<string, string> | undefined> {
    const r = await fetch(`${this.addr}/v1/secret/data/${this.path(tenant, pluginId)}`, {
      headers: { 'X-Vault-Token': this.token }, signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`secret store error ${r.status}`);
    return ((await r.json()) as { data: { data: Record<string, string> } }).data.data;
  }
}
