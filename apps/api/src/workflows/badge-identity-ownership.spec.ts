import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock } from './model.js';

// Fictional identities and a durable-row double only. No account service, mail or network.
const block = () => externalBlock('lyam-create-user')!;
const config = { identity: 'fictional.badge', displayName: 'Fictional Badge', email: 'badge@example.invalid', department: 'fixture' };
function fixture(options: { existing?: boolean; marker?: string | null; legacy?: boolean } = {}) {
  const columns = new Set(options.legacy ? ['id'] : ['id','email','login_enabled','credential_revision','workflow_creation_ref']);
  let row: { email: string | null; marker: unknown } | null = options.existing ? { email: config.email, marker: options.marker ?? null } : null;
  const writes: string[] = [];
  let failInsert = false, crashAfterWrite = false, entered = 0;
  const context = (over: Record<string, unknown> = {}) => ({
    tenant: 'fictional-tenant', runId: 'fictional-run', nodeId: 'create', config: { ...config }, settings: {}, dryRun: false, outputs: {}, log: () => undefined,
    branchWrite: async (fn: (db: unknown) => Promise<void>) => {
      entered++;
      await fn({ query: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith('show columns')) return [[...columns].map(Field => ({ Field })), undefined];
        if (sql.startsWith('select')) return [[{ n: row ? 1 : 0, email: columns.has('email') ? row?.email : null, workflow_creation_ref: columns.has('workflow_creation_ref') ? row?.marker : null }], undefined];
        writes.push(sql);
        if (sql.startsWith('alter table')) { const name = sql.match(/add column (\w+)/)?.[1]; if (name) columns.add(name); }
        if (sql.startsWith('insert')) {
          if (failInsert) { failInsert = false; throw Error('fixture insert failure'); }
          if (row) throw Error('fixture duplicate key');
          row = { email: params?.[3] as string | null, marker: params?.[4] };
        }
        return [{}, undefined];
      } });
      if (crashAfterWrite) { crashAfterWrite = false; throw Error('fixture output lost after committed row'); }
    }, ...over,
  } as never);
  return { context, writes, row: () => row, entered: () => entered, failNextInsert: () => { failInsert = true; }, loseNextOutput: () => { crashAfterWrite = true; } };
}

describe('workflow identity creation provenance', () => {
  it('stores a non-configurable execution marker in the very same identity INSERT', async () => {
    const f = fixture({ legacy: true }); const output = await block().run(f.context());
    assert.equal(output?.identity, config.identity);
    assert.equal(output?.email, config.email);
    assert.match(String(f.row()?.marker), /^[a-f0-9]{64}$/);
    assert.equal(f.writes.filter(s => s.startsWith('insert')).length, 1);
    assert.match(f.writes.find(s => s.startsWith('insert'))!, /credential_revision, workflow_creation_ref/);
  });
  for (const legacy of [true,false]) it(`refuses a foreign existing identity without schema or data writes (legacy=${legacy})`, async () => {
    const f = fixture({ existing: true, legacy });
    await assert.rejects(() => block().run(f.context()), /refusing to adopt/);
    assert.deepEqual(f.writes, []);
    assert.equal(f.row()?.email, config.email);
  });
  for (const key of ['tenant','runId','nodeId']) it(`refuses an identity created under another ${key}`, async () => {
    const f = fixture(); await block().run(f.context()); const before=f.writes.length;
    await assert.rejects(() => block().run(f.context({ [key]: 'another-execution' })), /refusing to adopt/);
    assert.equal(f.writes.length,before);
  });
  for (const key of ['tenant','runId','nodeId']) it(`requires server ${key} before entering a write`, async () => {
    const f = fixture(); await assert.rejects(() => block().run(f.context({[key]:undefined})), /server/);
    assert.equal(f.entered(),0); assert.deepEqual(f.writes,[]);
  });
  it('same-run/node retry uses the stored email, not a different requested email', async () => {
    const f = fixture(); await block().run(f.context()); const before=f.writes.length;
    const output = await block().run(f.context({config:{...config,email:'different@example.invalid'}}));
    assert.equal(output?.email,config.email); assert.equal(f.writes.length,before);
  });
  it('an INSERT failure leaves no separate ownership receipt that could be adopted', async () => {
    const f = fixture(); f.failNextInsert();
    await assert.rejects(() => block().run(f.context()), /fixture insert failure/);
    assert.equal(f.row(),null);
    await block().run(f.context()); assert.ok(f.row());
    assert.equal(f.writes.filter(s=>s.startsWith('insert')).length,2);
  });
  it('recovers the same durable row after the row write succeeded but the step output was lost', async () => {
    const f = fixture(); f.loseNextOutput();
    await assert.rejects(() => block().run(f.context()), /fixture output lost/);
    const snapshot=JSON.parse(JSON.stringify(f.row())); const before=f.writes.length;
    const output=await block().run(f.context());
    assert.deepEqual(f.row(),snapshot); assert.equal(f.writes.length,before); assert.equal(output?.email,config.email);
  });
});
