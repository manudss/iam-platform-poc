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
