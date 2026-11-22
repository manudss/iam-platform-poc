import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
const api = loadPluginModule('workflow-connectors', 'sheets-api.mjs') as any;
const header = { row: 1, values: { A: 'email', B: 'ticket', C: 'badge', D: 'cree' } };
const target = { row: 3, values: { A: 'fiction@example.test' } };
const source = { spreadsheetId: 'fictional-sheet', sheetId: 7 };
const auth = {};

describe('keyed Google writes and preflight (intercepted actions, no network)', () => {
  it('resolves the current row after a sort, not the trigger row', async () => {
    const calls: any[] = [];
    const fake = async (_pkg: string, action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'get-many-rows') return [header, { row: 2, values: { A: 'other@example.test' } }, target];
      return {};
    };
    await api.writeGoogleRowByKey(auth, source, { ticket: 'KAN-99' }, 'email', 'fiction@example.test', fake);
    assert.equal(calls[1].action, 'update_row');
    assert.equal(calls[1].args.propsValue.row_id, 3);
    assert.deepEqual(calls[1].args.propsValue.values, { B: 'KAN-99' });
  });
  it('each retry resolves again if the row moved since the previous attempt', async () => {
    const written: number[] = []; let row = 2;
    const fake = async (_pkg: string, action: string, args: any) => {
      if (action === 'get-many-rows') return [header, { ...target, row }];
      written.push(args.propsValue.row_id); if (written.length === 1) throw Error('lost response'); return {};
    };
    await assert.rejects(() => api.writeGoogleRowByKey(auth, source, { ticket: 'KAN-99' }, 'email', 'fiction@example.test', fake));
    row = 8;
    await api.writeGoogleRowByKey(auth, source, { ticket: 'KAN-99' }, 'email', 'fiction@example.test', fake);
    assert.deepEqual(written, [2, 8]);
  });
  it('preflight refuses a missing or duplicate header or missing/ambiguous key before writes', async () => {
    const bad = [
      [{ row: 1, values: { A: 'email', B: 'ticket', D: 'cree' } }, target],
      [{ row: 1, values: { A: 'email', C: 'badge', D: 'cree' } }, target],
      [{ row: 1, values: { ...header.values, E: 'email' } }, target],
      [header],
      [header, target, { ...target, row: 4 }],
    ];
    for (const snapshot of bad) {
      let writes = 0;
      const fake = async (_pkg: string, action: string) => { if (action !== 'get-many-rows') writes++; return snapshot; };
      await assert.rejects(() => api.preflightGoogleRow(auth, source, 'email', 'fiction@example.test', ['email', 'ticket', 'badge', 'cree'], fake));
      await assert.rejects(() => api.writeGoogleRowByKey(auth, source, { badge: 'ok', ticket: 'KAN-99' }, 'email', 'fiction@example.test', fake));
      assert.equal(writes, 0);
    }
  });
});
