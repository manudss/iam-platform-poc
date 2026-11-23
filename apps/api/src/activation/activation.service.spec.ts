import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ActivationService } from './activation.service.js';

// In-memory journal (dev default, IAM_PG_URL unset): seqs restart at 1, so a floor from the live core
// (main publication startup) is what keeps a restarted API converging instead of hitting 409 forever.
function setup() {
  const secrets = { get: async () => undefined };
  delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_URL; delete process.env.IAM_CORE_ADMIN_TOKEN;
  return new ActivationService(secrets as never);
}
const C1 = '0123456789abcdef', C2 = 'aaaaaaa1bbbbbbb2';

it('journal allocates sequential seqs from 1 without a floor', async () => {
  const s = setup();
  assert.equal((await s.activate('t1', C1)).seq, 1);
  assert.equal((await s.activate('t1', C2)).seq, 2);
});
it('a floor below the journal changes nothing', async () => {
  const s = setup();
  await s.activate('t1', C1);
  assert.equal((await s.activate('t1', C2, undefined, 2)).seq, 2);
});
it('a floor above the journal raises the allocated seq (core ahead after restart)', async () => {
  const s = setup();
  assert.equal((await s.activate('t1', C2, undefined, 3)).seq, 3);
  assert.equal((await s.activate('t1', C1)).seq, 4); // journal continues from the raised seq
});
it('floors are per tenant', async () => {
  const s = setup();
  await s.activate('t1', C1, undefined, 9);
  assert.equal((await s.activate('t2', C1)).seq, 1);
});
it('an invalid floor is refused', async () => {
  const s = setup();
  await assert.rejects(s.activate('t1', C1, undefined, 0), /minSeq/);
});

it('observed live sequence protects later activations even when startup skipped the same commit', async () => {
  const s = setup();
  s.observeCoreSequence('t1', 2);
  assert.equal((await s.activate('t1', C2)).seq, 3);
  assert.equal((await s.activate('t1', C1)).seq, 4);
  assert.equal((await s.activate('t2', C1)).seq, 1);
});

it('PostgreSQL allocation carries the floor inside the existing tenant transaction', async () => {
  const s = setup();
  const queries: {sql:string; args?:unknown[]}[]=[];
  const c={query:async(sql:string,args?:unknown[])=>{queries.push({sql,args});return {rows:[{seq:8}]};},release:()=>{}};
  (s as any).resolved=Promise.resolve('postgresql://fixture');
  (s as any).db=async()=>({connect:async()=>c});
  assert.equal((await s.activate('t1',C1,undefined,8)).seq,8);
  assert.match(queries[1].sql,/pg_advisory_xact_lock/);
  assert.match(queries[2].sql,/GREATEST/);
  assert.deepEqual(queries[2].args,['t1',8]);
  assert.equal(queries.at(-1)?.sql,'COMMIT');
});
