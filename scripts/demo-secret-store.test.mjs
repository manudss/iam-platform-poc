import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startDemoBao } from '../demo/secret-store.mjs';
const binary = process.env.BAO_BIN;
it('demo OpenBao: immutable scoped credentials, no admin/outside access, no root for API', { skip: !binary || !existsSync(binary) }, async () => {
  const store = await startDemoBao({ binary, port: 14379 });
  const call = (path, method = 'GET', body) => fetch(`${store.address}/v1/${path}`, { method, headers: { 'X-Vault-Token': store.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal(store.rootRevoked, true);
    const path = 'secret/data/iam/workflow-connections/demo/conn-fixture/revision';
    const value = { options: { cas: 0 }, data: { value: 'FICTIONAL-TEST-ONLY' } };
    assert.equal((await call(path, 'POST', value)).status, 200);
    assert.equal((await (await call(path)).json()).data.data.value, 'FICTIONAL-TEST-ONLY');
    assert.equal((await call(path, 'POST', value)).status, 400);
    assert.equal((await call('secret/data/unrelated', 'POST', value)).status, 403);
    assert.equal((await call('sys/mounts')).status, 403);
    assert.equal((await call('auth/token/create', 'POST', { policies: ['root'] })).status, 403);
    assert.equal((await call(path, 'DELETE')).status, 403);
    assert.equal((await fetch(`${store.address}/v1/${path}`)).status, 403);
  } finally { store.stop(); await new Promise(r => store.child.once('exit', r)); }
});
