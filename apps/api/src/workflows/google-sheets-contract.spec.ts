import 'reflect-metadata';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { externalBlock, externalEvent } from './model.js';
import { WorkflowConnections } from './connections.js';
process.env.IAM_WORKFLOW_REAL_CONNECTIONS = '1';   // real connections are off by default on a server; these specs exercise them with fictional values
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

describe('google-sheets-update through the block with the installed piece (network fixtures, not live Google)', () => {
  const COLUMN = 'badge fait / mail envoyé';
  const key = () => { const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }); return JSON.stringify({ type: 'service_account', client_email: 'fixture@fictional.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' }); };
  function fixture(hdr: string[]) {
    nock.disableNetConnect();
    nock('https://oauth2.googleapis.com').persist().post('/token').reply(200, { access_token: 'FICTIONAL-GOOGLE-TOKEN', token_type: 'Bearer', expires_in: 3600 });
    nock('https://www.googleapis.com').persist().post('/oauth2/v4/token').reply(200, { access_token: 'FICTIONAL-GOOGLE-TOKEN', token_type: 'Bearer', expires_in: 3600 });
    nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional-contract-sheet').reply(200, { sheets: [{ properties: { sheetId: 7, title: 'Candidates' } }] });
    nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri: string) {
      const range = decodeURIComponent(uri.split('/values/')[1]);
      return [200, { values: range.includes('A1:ZZZ1') ? [hdr] : [hdr, ['Martin', 'Camille', 'finance', 'employee', 'OK', 'ok']] }];
    });
  }
  const run = (settings: unknown) => externalBlock('google-sheets-update')!.run({ config: { ...source, rowNumber: '2', column: COLUMN, value: 'ok' }, settings, dryRun: false, log: () => {} } as any);
  it('a missing column fails before any write and leaves the sheet untouched', async () => {
    fixture([...headers]);
    let writes = 0;
    nock('https://sheets.googleapis.com').persist().put(/\/values\//).reply(() => { writes++; return [200, {}]; });
    await assert.rejects(() => run({ googleServiceAccount: key() }), /unique/);
    assert.equal(writes, 0);
  });
  it('once the column exists the same step writes only that cell, in the right column letter', async () => {
    fixture([...headers, COLUMN]);
    let body: any;
    const write = nock('https://sheets.googleapis.com').put(/\/values\/.*A2%3AZZZ2/).query(true).reply(200, (_u: string, b: any) => { body = b; return { updatedRange: 'Candidates!G2', updatedCells: 1 }; });
    const out = await run({ googleServiceAccount: key() });
    assert.equal((out as any).updated, true); assert.ok(write.isDone());
    assert.deepEqual(body.values, [[null, null, null, null, null, null, 'ok']]);
  });
});

describe('Find Rows and Create Column installed piece contracts', () => {
  const auth = { type: 'OAUTH2', access_token: 'FICTIONAL-CONTRACT' };
  it('Find Rows resolves a named header and returns only exact matches with real row numbers', async () => {
    googleFixture();
    const rows = await helpers.findGoogleRows(auth, source, 'nom', 'Durand', 100);
    assert.deepEqual(rows.map((r: any) => r.rowNumber), [4]);
    assert.equal(rows[0].values.nom, 'Durand');
  });
  it('Create Column inserts at the end then writes its header, through the installed piece', async () => {
    googleFixture();
    const insert = nock('https://sheets.googleapis.com').post('/v4/spreadsheets/fictional-contract-sheet:batchUpdate', (body: any) => {
      assert.equal(body.requests[0].insertDimension.range.startIndex, headers.length);
      assert.equal(body.requests[0].insertDimension.range.dimension, 'COLUMNS');
      return true;
    }).reply(200, {});
    const write = nock('https://sheets.googleapis.com').put(/\/values\//, (body: any) => {
      assert.deepEqual(body.values, [['new-column']]); return true;
    }).query(true).reply(200, { updatedCells: 1 });
    await helpers.createGoogleColumn(auth, source, 'new-column');
    assert.ok(insert.isDone() && write.isDone());
  });
});


describe('candidate email initialization via installed piece (intercepted Google, not live)',()=>{
 it('flat identity with quotes and backslashes writes only email and reads it back',async()=>{
  nock.disableNetConnect();
  const hdr=['nom','prenom','departement','role','process','cree','ticket','badge-fait','email'];
  const nom='Martin "Test"',prenom='Camille\\Demo',departement=' IT ',role='';
  const values=[nom,prenom,departement,role,'OK','','','',''];let writes=0,marked=false;
  nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional-contract-sheet').reply(200,{sheets:[{properties:{sheetId:7,title:'Candidates'}}]});
  nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri:string){const range=decodeURIComponent(uri.split('/values/')[1]);return [200,{values:range.includes('A1:ZZZ1')?[hdr]:range.includes('A2:ZZZ')?[values]:[hdr,values]}];});
  nock('https://sheets.googleapis.com').put(/\/values\//).query(true).reply((_uri:string,body:any)=>{assert.ok(marked);writes++;assert.deepEqual(body.values,[[null,null,null,null,null,null,null,null,'camille.martin@dss.name']]);values[8]='camille.martin@dss.name';return [200,{updatedCells:1,updatedRange:'Candidates!I2'}];});
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const secret=JSON.stringify({type:'service_account',client_email:'fixture@fictional.iam.gserviceaccount.com',private_key:privateKey,token_uri:'https://oauth2.googleapis.com/token'});
  nock('https://oauth2.googleapis.com').persist().post('/token').reply(200,{access_token:'FICTIONAL',token_type:'Bearer',expires_in:3600});
  nock('https://www.googleapis.com').persist().post('/oauth2/v4/token').reply(200,{access_token:'FICTIONAL',token_type:'Bearer',expires_in:3600});
  const model=loadPluginModule('workflows-iga','model.mjs') as any;
  const graph=model.substituteEventPayload({nodes:[{id:'init',type:'google-sheets-update',config:{...source,checked:true,matchColumn1:'nom',matchValue1:'{{event.nom}}',matchColumn2:'prenom',matchValue2:'{{event.prenom}}',matchColumn3:'departement',matchValue3:'{{event.departement}}',matchColumn4:'role',matchValue4:'',checkColumn1:'process',checkValue1:'OK',checkColumn2:'cree',checkValue2:'',checkColumn3:'ticket',checkValue3:'',checkColumn4:'badge-fait',checkValue4:'',column:'email',value:'camille.martin@dss.name',uniqueValue:true,requireExpected:true}}],edges:[]},{nom,prenom,departement});
  const block=externalBlock('google-sheets-update')!;
  const config=block.validate(graph.nodes[0].config);assert.equal(config.matchValue1,nom);assert.equal(config.matchValue2,prenom);assert.equal(config.matchValue3,departement);
  const out=await block.run({config,settings:{googleServiceAccount:secret},dryRun:false,log(){},markEffectPending:async()=>{marked=true;}} as any);
  assert.deepEqual(out,{value:'camille.martin@dss.name',updated:true,written:true});assert.equal(writes,1);
  const again=await block.run({config,settings:{googleServiceAccount:secret},dryRun:false,log(){},markEffectPending:async()=>{throw Error('no second intent');}} as any);assert.equal(again!.written,false);assert.equal(writes,1);
 });
});
