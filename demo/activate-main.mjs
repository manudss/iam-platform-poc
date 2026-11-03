// Demo-only startup bootstrap. Never merge a branch or replace an existing live version.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function activateDemoMain({ core, tenant = 'acme-demo', dolt, activation, request = fetch }) {
  const version = await request(`${core}/v1/version?tenant=${encodeURIComponent(tenant)}`);
  if (version.ok) return { action: 'already-active' };
  if (version.status !== 404) throw new Error(`Cannot check demo live version: HTTP ${version.status}`);
  const commit = await dolt.head();
  const result = await activation.activate(tenant, commit, `demo-bootstrap-${commit}`);
  if (result.state !== 'applied') throw new Error(`Demo activation failed: ${result.error ?? result.state}`);
  return { action: 'activated', commit, seq: result.seq };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const api = process.env.IAM_DEMO_API_DIR ?? '/app/api/dist';
  const { DoltService } = await import(pathToFileURL(resolve(api, 'dolt/dolt.service.js')).href);
  const { ActivationService } = await import(pathToFileURL(resolve(api, 'activation/activation.service.js')).href);
  const activation = new ActivationService();
  try {
    const result = await activateDemoMain({ core: process.env.IAM_CORE_URL, dolt: new DoltService(), activation });
    console.log('[demo] permissions bootstrap:', JSON.stringify(result));
  } finally { await activation.onModuleDestroy(); }
}
