// Demo-only, ephemeral, loopback OpenBao. Not a production secrets deployment.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export async function startDemoBao({ binary = 'bao', port = 8200, onLog = () => {} } = {}) {
  const root = randomBytes(32).toString('hex');
  const address = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ['server', '-dev', '-dev-no-store-token', `-dev-listen-address=127.0.0.1:${port}`], { env: { ...process.env, BAO_DEV_ROOT_TOKEN_ID: root, GOMEMLIMIT: '64MiB' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  // The dev server emits root and unseal credentials. Never persist its output.
  // Only generic lifecycle messages leave this wrapper.
  child.stdout.resume(); child.stderr.resume();
  const call = async (path, body, token = root) => {
    const r = await fetch(`${address}/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`demo secret-store operation failed (${r.status})`);
    return r.status === 204 ? {} : r.json();
  };
  try {
    let ready = false;
    for (let n = 0; n < 150; n++) {
      if (exited) throw new Error('demo secret store exited before readiness');
      try { ready = (await fetch(`${address}/v1/sys/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready) throw new Error('demo secret store did not become ready');
    await call('sys/policies/acl/lyam-demo-connections', { policy: 'path "secret/data/iam/workflow-connections/*" { capabilities = ["create", "update", "read"] } path "secret/data/iam/pg" { capabilities = ["read"] }' });
    const result = await call('auth/token/create-orphan', { policies: ['lyam-demo-connections'], no_default_policy: true, ttl: '24h', renewable: false, display_name: 'lyam-ephemeral-demo' });
    const token = result.auth?.client_token;
    if (!token) throw new Error('demo secret store returned no scoped token');
    await call('auth/token/revoke-self', {});
    onLog('demo secret store ready on loopback; root revoked; scoped token expires in 24h');
    return { address, token, child, stop: () => child.kill(), rootRevoked: true };
  } catch (error) { child.kill(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const store = await startDemoBao({ onLog: m => console.log(`[demo] ${m}`) });
    writeFileSync(process.argv[2], store.token, { mode: 0o600, flag: 'wx' });
    store.child.once('exit', () => { console.error('[demo] secret store exited; authenticated connections fail closed'); process.exit(1); });
    process.once('SIGTERM', () => store.stop());
    process.once('SIGINT', () => store.stop());
  } catch { console.error('[demo] secret-store bootstrap failed'); process.exit(1); }
}
