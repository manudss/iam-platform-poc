import { runPieceAction } from './adapter.mjs';
const PACKAGE = '@activepieces/piece-google-sheets';

// Activepieces 0.19.5 has a discriminated auth union and returns {row, values},
// not flat records. Keep that boundary in one place for probes, blocks and polling.
export function serviceAccountAuth(serviceAccount, userEmail) {
  return { type: 'CUSTOM_AUTH', props: { serviceAccount, userEmail: userEmail || undefined } };
}
export function sheetRows(result) {
  if (!Array.isArray(result)) throw new Error('Google Sheets returned an invalid row list');
  return result.map(r => {
    if (!r || !Number.isInteger(r.row) || r.row < 1 || !r.values || typeof r.values !== 'object' || Array.isArray(r.values)) throw new Error('Google Sheets returned an invalid row');
    return { rowNumber: r.row, values: { ...r.values } };
  });
}
export async function readGoogleRows(auth, source, headers = true, run = runPieceAction) {
  return sheetRows(await run(PACKAGE, 'get-many-rows', { auth, propsValue: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false, first_row_headers: headers } }));
}
export function namedColumns(header, values) {
  if (!header || header.rowNumber !== 1) throw new Error('Google Sheet requires a header row');
  const mapped = {};
  for (const [name, value] of Object.entries(values)) {
    const matches = Object.entries(header.values).filter(([, v]) => String(v) === name);
    if (matches.length !== 1) throw new Error('Google Sheet column must have one unique matching header');
    const letter = matches[0][0];
    if (!/^[A-Z]{1,3}$/.test(letter)) throw new Error('Google Sheet returned an invalid column');
    mapped[letter] = value;
  }
  return mapped;
}
export async function writeGoogleRow(auth, source, values, rowNumber, run = runPieceAction) {
  // update_row/insert_row dynamic values use A/B/... even with first_row_headers.
  // Null holes in update_row preserve the other cells; header names must never be
  // passed to Activepieces' column-letter conversion.
  const headers = await readGoogleRows(auth, source, false, run);
  const mapped = namedColumns(headers.find(r => r.rowNumber === 1), values);
  return run(PACKAGE, rowNumber === undefined ? 'insert_row' : 'update_row', {
    auth, propsValue: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false, first_row_headers: true, as_string: true, values: mapped, ...(rowNumber === undefined ? {} : { row_id: rowNumber }) },
  });
}

/** Resolve a unique stable row key and every required header from one fresh raw snapshot.
 * Google update_row is positional: concurrent edits between this read and the write still require an operator freeze.
 */
export function keyedRow(snapshot, keyColumn, keyValue, requiredColumns = []) {
  const header = snapshot.find(r => r.rowNumber === 1);
  const wanted = [...new Set([keyColumn, ...requiredColumns])];
  const letters = namedColumns(header, Object.fromEntries(wanted.map(k => [k, 'check'])));
  const keyLetter = Object.keys(namedColumns(header, { [keyColumn]: 'check' }))[0];
  const matches = snapshot.filter(r => r.rowNumber > 1 && String(r.values[keyLetter] ?? '') === String(keyValue));
  if (!keyValue || matches.length !== 1) throw new Error('Google Sheet key must match exactly one row');
  return { rowNumber: matches[0].rowNumber, header, letters };
}
export async function preflightGoogleRow(auth, source, keyColumn, keyValue, requiredColumns, run = runPieceAction) {
  return keyedRow(await readGoogleRows(auth, source, false, run), keyColumn, keyValue, requiredColumns).rowNumber;
}
export async function writeGoogleRowByKey(auth, source, values, keyColumn, keyValue, run = runPieceAction) {
  const row = keyedRow(await readGoogleRows(auth, source, false, run), keyColumn, keyValue, Object.keys(values));
  const mapped = namedColumns(row.header, values);
  return run(PACKAGE, 'update_row', { auth, propsValue: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false, first_row_headers: true, as_string: true, values: mapped, row_id: row.rowNumber } });
}

/** Adds a header column. Refuses a header that already exists (one fresh read first); the piece appends after the last header. */
export async function createGoogleColumn(auth, source, columnName, run = runPieceAction) {
  const header = (await readGoogleRows(auth, source, false, run)).find(r => r.rowNumber === 1);
  if (!header) throw new Error('Google Sheet requires a header row');
  if (Object.values(header.values).some(v => String(v) === columnName)) throw new Error('Google Sheet column already exists');
  const result = await run(PACKAGE, 'create-column', { auth, propsValue: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false, columnName } });
  if (!(Number(result?.updatedCells) >= 1)) throw new Error('Google Sheets did not confirm the new column header; inspect the sheet before retrying');
  return result;
}

/** Uses the installed Find Rows action. Resolve the named header first because its columnName is a LETTER, not a header label. */
export async function findGoogleRows(auth, source, columnName, searchValue, limit = 100, run = runPieceAction) {
  const raw = await readGoogleRows(auth, source, false, run);
  const header = raw.find(r => r.rowNumber === 1);
  const letter = Object.keys(namedColumns(header, { [columnName]: 'find' }))[0];
  return sheetRows(await run(PACKAGE, 'find_rows', { auth, propsValue: {
    spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false,
    columnName: letter, searchValue, matchCase: true, startingRow: 2, numberOfRows: limit,
    headerRow: 1, useHeaderNames: true,
  } }));
}


/** Assisted-demo initialization only: Google updates are positional, not conditional or locked.
 * Re-read identity and the full source row before writing; stop on any drift or uncertain response.
 */
export async function initializeGoogleEmail(auth, source, expected, email, requiredColumns = [], markPending, run = runPieceAction) {
  const identityKeys = ['nom','prenom','departement','role'];
  const expectedKeys = Object.keys(expected);
  const canonical = values => JSON.stringify(Object.entries(values).filter(([,v]) => v !== '' && v != null).map(([k,v]) => [k,String(v)]).sort(([a],[b]) => a.localeCompare(b)));
  function select(snapshot) {
    if (new Set(snapshot.map(r=>r.rowNumber)).size !== snapshot.length) throw new Error('Google Sheet returned duplicate row positions');
    const header = snapshot.find(r => r.rowNumber === 1);
    const names = Object.values(header?.values ?? {}).map(String);
    if (new Set(names).size !== names.length) throw new Error('Google Sheet headers must be unique');
    const needed = [...new Set([...expectedKeys, 'email', ...requiredColumns])];
    const letters = Object.fromEntries(needed.map(name => [name, Object.keys(namedColumns(header, { [name]: 'check' }))[0]]));
    const matches = snapshot.filter(r => r.rowNumber > 1 && identityKeys.every(k => String(r.values[letters[k]] ?? '') === expected[k]));
    if (matches.length !== 1) throw new Error('Sheet source identity must match exactly one row');
    const row = matches[0];
    if (!expectedKeys.every(k=>String(row.values[letters[k]]??'')===expected[k])) throw new Error('Sheet source is no longer eligible for initialization');
    const current = String(row.values[letters.email] ?? '');
    if (current && current.toLowerCase() !== email.toLowerCase()) throw new Error('Sheet source email is already different; nothing overwritten');
    if (snapshot.some(r => r.rowNumber > 1 && r.rowNumber !== row.rowNumber && String(r.values[letters.email] ?? '').trim().toLowerCase() === email.toLowerCase())) throw new Error('Calculated email already belongs to another sheet row');
    return { header, row, current, emailLetter: letters.email };
  }
  const read = async () => select(await readGoogleRows(auth, source, false, run));
  const first = await read(), second = await read();
  if (canonical(first.header.values) !== canonical(second.header.values) || canonical(first.row.values) !== canonical(second.row.values)) throw new Error('Sheet source changed during initialization; reconcile before retry');
  if (second.current) return { email: second.current, initialized: true, written: false };
  if (typeof markPending !== 'function') throw new Error('Durable sheet effect tracking is unavailable');
  await markPending({ kind: 'sheet-email-initialization' });
  await run(PACKAGE, 'update_row', { auth, propsValue: { spreadsheetId: source.spreadsheetId, sheetId: source.sheetId, includeTeamDrives: false, first_row_headers: true, as_string: true, values: { [second.emailLetter]: email }, row_id: second.row.rowNumber } });
  const after = await read();
  const wanted = { ...second.row.values, [second.emailLetter]: email };
  if (canonical(after.header.values) !== canonical(second.header.values) || canonical(after.row.values) !== canonical(wanted) || after.current !== email) throw new Error('Sheet initialization readback differs; external effect needs review');
  return { email: after.current, initialized: true, written: true };
}
