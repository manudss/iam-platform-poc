import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { externalBlock } from './model.js';
const api = loadPluginModule('workflow-connectors', 'sheets-api.mjs') as any;
// DOUBLE: the piece runner is injected; this shows the preflight and the call shape, not a live Google sheet.
const src = { source: 'google', spreadsheetId: 'fictional-sheet', sheetId: 7 };
const runner = (header: string[], calls: { action: string; props: any }[]) => async (_pkg: string, action: string, a: { propsValue: any }) => {
  calls.push({ action, props: a.propsValue });
  if (action === 'get-many-rows') return [{ row: 1, values: Object.fromEntries(header.map((h, i) => [String.fromCharCode(65 + i), h])) }];
  return { updatedCells: 1 };
};
describe('google sheets create column', () => {
  it('adds a new header after one fresh read', async () => {
    const calls: { action: string; props: any }[] = [];
    await api.createGoogleColumn({}, src, 'status', runner(['name', 'mail'], calls));
    assert.deepEqual(calls.map((c) => c.action), ['get-many-rows', 'create-column']);
    assert.equal(calls[1].props.columnName, 'status');
  });
  it('refuses a duplicate header and a sheet without header, never calling create', async () => {
    const calls: { action: string; props: any }[] = [];
    await assert.rejects(api.createGoogleColumn({}, src, 'mail', runner(['name', 'mail'], calls)), /already exists/);
    await assert.rejects(api.createGoogleColumn({}, src, 'x', async () => []), /header row/);
    assert.ok(!calls.some((c) => c.action === 'create-column'));
  });
  it('the block is a no-op on the demo sheet and in dry run, and refuses a real call without connection', async () => {
    const b = externalBlock('google-sheets-create-column')!;
    const mk = (config: unknown, dryRun = false, settings = {}) => ({ tenant: 'acme', config, settings, dryRun, log: () => {}, outputs: {} }) as never;
    assert.equal(((await b.run(mk(b.validate({ columnName: 'x' })))) as { created: boolean }).created, false);
    assert.equal(((await b.run(mk(b.validate({ source: 'google', spreadsheetId: 's', sheetId: 1, columnName: 'x' }), true))) as { created: boolean }).created, false);
    await assert.rejects(b.run(mk(b.validate({ source: 'google', spreadsheetId: 's', sheetId: 1, columnName: 'x' }))), /managed Google Sheets connection/);
  });
});
