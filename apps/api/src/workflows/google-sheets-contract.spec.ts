import 'reflect-metadata';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { externalBlock, externalEvent } from './model.js';
import { WorkflowConnections } from './connections.js';
const helpers = loadPluginModule('workflow-connectors', 'sheets-api.mjs') as any;
// Network fixtures exercise the INSTALLED Activepieces package, not a substitute
// for its run() implementation. They are not evidence of a live Google account.
const headers = ['nom', 'prenom', 'departement', 'role', 'process', 'cree'];
const data = [headers, ['Martin', 'Camille', 'finance', 'employee', 'OK', ''], [], ['Durand', 'Alex', 'ops', 'employee', 'En cours', '']];
const source = { source: 'google', spreadsheetId: 'fictional-contract-sheet', sheetId: 7 };
function googleFixture() {
  nock.disableNetConnect();
  nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional-contract-sheet').reply(200, { sheets: [{ properties: { sheetId: 7, title: 'Candidates' } }] });
  nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri: string) {
    const range = decodeURIComponent(uri.split('/values/')[1]);
    return [200, { values: range.includes('A1:ZZZ1') ? [headers] : range.includes('A2:ZZZ') ? data.slice(1) : data }];
  });
}
afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });
describe('Google Sheets installed-piece contract (network fixtures, not live Google)', () => {
  it('keeps actual row numbers, flattens header-mapped values and filters readiness across blank rows', async () => {
    googleFixture();
    const auth = { type: 'OAUTH2', access_token: 'FICTIONAL-NETWORK-FIXTURE' };
    const rows = await helpers.readGoogleRows(auth, source);
    assert.deepEqual(rows.map((r: any) => r.rowNumber), [2, 3, 4]);
    assert.equal(rows[0].values.nom, 'Martin');
    assert.equal(rows[2].values.nom, 'Durand');
    assert.deepEqual(helpers.sheetRows([{ row: 9, values: { process: 'OK' } }]), [{ rowNumber: 9, values: { process: 'OK' } }]);
    assert.throws(() => helpers.sheetRows([{ row: 0, values: {} }]));
  });
  it('maps the done header to F and preserves the other cells with null holes', async () => {
    googleFixture();
    const write = nock('https://sheets.googleapis.com').put(/\/values\//, (body: any) => {
      assert.deepEqual(body.values, [[null, null, null, null, null, 'ok']]);
      return true;
    }).query({ valueInputOption: 'USER_ENTERED' }).reply(200, { updatedRange: 'Candidates!A2:F2', updatedCells: 1 });
    const result = await helpers.writeGoogleRow({ type: 'OAUTH2', access_token: 'FICTIONAL' }, source, { cree: 'ok' }, 2);
    assert.equal(result.row, 2); assert.ok(write.isDone());
  });
  it('refuses absent or duplicate headers before writing', () => {
    assert.throws(() => helpers.namedColumns({ rowNumber: 1, values: { A: 'nom' } }, { cree: 'ok' }), /unique/);
    assert.throws(() => helpers.namedColumns({ rowNumber: 1, values: { A: 'cree', B: 'cree' } }, { cree: 'ok' }), /unique/);
  });
  it('uses CUSTOM_AUTH for both the read-only managed probe and the real watcher', async () => {
    googleFixture();
    // Ephemeral fictional RSA key only, never an account credential.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const secret = JSON.stringify({ type: 'service_account', client_email: 'fixture@fictional.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' });
    nock('https://oauth2.googleapis.com').persist().post('/token').reply(200, { access_token: 'FICTIONAL-GOOGLE-TOKEN', token_type: 'Bearer', expires_in: 3600 });
    nock('https://www.googleapis.com').persist().post('/oauth2/v4/token').reply(200, { access_token: 'FICTIONAL-GOOGLE-TOKEN', token_type: 'Bearer', expires_in: 3600 });
    const service = new WorkflowConnections({} as any, {} as any);
    const result = await service.testDraft('demo', { name: 'Fixture', provider: 'google-sheets', config: { spreadsheetId: source.spreadsheetId, sheetId: '7' }, secret });
    assert.equal(result.status, 'Verified');
    assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
    const ready = await externalEvent('google-sheets.row-ready')!.poll!({ ...source, watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' }, { settings: { googleServiceAccount: secret }, log: () => {} });
    assert.deepEqual(ready.map(r => r.rowNumber), [2]); assert.equal(ready[0].values.prenom, 'Camille');
    const read = await externalBlock('google-sheets-read')!.run({ config: { ...source, mode: 'find-row', columnName: 'nom', searchValue: 'Durand' }, settings: { googleServiceAccount: secret }, dryRun: false, log: () => {} } as any);
    assert.equal(read!.rowNumber, 4); assert.equal((read!.row as any).prenom, 'Alex');
  });
});
