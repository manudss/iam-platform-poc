/**
 * The built-in DEMO sheet: a simulated "HR candidates" Google Sheet so the onboarding workflow runs
 * end-to-end without any Google credential. It is clearly labelled SIMULATED everywhere it shows up:
 * nothing here is a real Google document, and a restart resets it to the seed rows below.
 * Switch a block (or the row-watcher trigger) to source "google" once a service account JSON key is
 * typed in the plugin settings: the same blocks then talk to the real Google Sheets API.
 */

export const DEMO_SHEET_NAME = 'Candidats RH (démo simulée)';
// ASCII keys on purpose: they become {{event.<key>}} payload keys, restricted to [a-z] by the workflow model.
export const DEMO_SHEET_COLUMNS = ['nom', 'prenom', 'departement', 'role', 'process', 'cree'];

const SEED_ROWS = [
  { nom: 'Martin', prenom: 'Camille', departement: 'finance', role: 'accountant', process: 'OK', cree: '' },
  { nom: 'Bernard', prenom: 'Léa', departement: 'engineering', role: 'employee', process: 'En cours', cree: '' },
  { nom: 'Dubois', prenom: 'Hugo', departement: 'finance', role: 'payment-creator', process: 'OK', cree: '' },
];

/** In-memory rows, 1-based row numbers with the header on row 1 (data starts at row 2), like a real sheet. */
const rows = SEED_ROWS.map((r) => ({ ...r }));

export const demoSheet = {
  /** A read copy of the sheet: [{ rowNumber, values }]. */
  rows() {
    return rows.map((r, i) => ({ rowNumber: i + 2, values: { ...r } }));
  },
  /** Rows whose watch column equals watchValue and whose done column is not yet doneValue. */
  readyRows({ watchColumn = 'process', watchValue = 'OK', doneColumn = 'cree', doneValue = 'ok' }) {
    return this.rows().filter((r) => String(r.values[watchColumn] ?? '') === watchValue && String(r.values[doneColumn] ?? '') !== doneValue);
  },
  updateCell(rowNumber, column, value) {
    const r = rows[rowNumber - 2];
    if (!r) throw new Error(`demo sheet: no row ${rowNumber}`);
    if (!DEMO_SHEET_COLUMNS.includes(column)) throw new Error(`demo sheet: unknown column "${column}" (${DEMO_SHEET_COLUMNS.join(', ')})`);
    r[column] = String(value);
    return { rowNumber, column, value: r[column] };
  },
  addRow(values) {
    const clean = {};
    for (const c of DEMO_SHEET_COLUMNS) clean[c] = String(values?.[c] ?? '').slice(0, 80);
    rows.push(clean);
    return { rowNumber: rows.length + 1, values: { ...clean } };
  },
};
