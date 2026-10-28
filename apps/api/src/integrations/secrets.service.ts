import { Injectable } from '@nestjs/common';

/**
 * Reads a secret from OpenBao (Vault-compatible KV v2 HTTP API) when IAM_BAO_ADDR + IAM_BAO_TOKEN are set.
 * POC scope: token auth only (no AppRole/Kubernetes auth, no lease renewal, no transit/PKI). Local dev token only.
 */
@Injectable()
export class SecretsService {
  get enabled() { return !!process.env.IAM_BAO_ADDR && !!process.env.IAM_BAO_TOKEN; }

  /** KV v2 read: mount "secret", e.g. get('iam/pg') reads secret/data/iam/pg. Returns undefined if absent or disabled. */
  async get(path: string): Promise<Record<string, string> | undefined> {
    if (!this.enabled) return undefined;
    const r = await fetch(`${process.env.IAM_BAO_ADDR}/v1/secret/data/${path}`, { headers: { 'X-Vault-Token': process.env.IAM_BAO_TOKEN! } });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`secret store error ${r.status}`);
    return ((await r.json()) as { data: { data: Record<string, string> } }).data.data;
  }
}
