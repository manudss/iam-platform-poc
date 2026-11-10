import { demoSheet, DEMO_SHEET_COLUMNS, DEMO_SHEET_NAME } from './demo-sheet.mjs';

/**
 * HTTP routes of the plugin (mounted under /tenants/:tenant/plugins/workflow-connectors/, admin-only):
 * inspect and edit the built-in DEMO sheet (the simulated "HR candidates" Google Sheet) so the seeded
 * onboarding workflow can be driven by hand without any Google credential.
 */
export default {
  'http:GET /demo-sheet': (_p, _c) => ({
    name: DEMO_SHEET_NAME,
    simulated: true,
    note: 'Simulated sheet: not a real Google document, reset on restart. Switch the trigger/blocks to source "google" with a service account for the real thing.',
    columns: DEMO_SHEET_COLUMNS,
    rows: demoSheet.rows(),
  }),
  'http:POST /demo-sheet/rows': (p, _c) => {
    const added = demoSheet.addRow(p.body ?? {});
    return { status: 201, body: { added, note: 'the row watcher starts the workflow within a minute when process = OK' } };
  },
  'http:PUT /demo-sheet/rows/:row': (p, _c) => {
    const rowNumber = Number(p.params?.row);
    const body = p.body ?? {};
    const updated = demoSheet.updateCell(rowNumber, String(body.column ?? ''), String(body.value ?? ''));
    return { updated };
  },
};
