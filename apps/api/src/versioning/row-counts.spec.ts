import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowCounts, sumRows } from './versioning.service.js';

test('row counts come from dolt_diff_stat and add up (the toolbar badge counts rows, not tables)', () => {
  const m = rowCounts([
    { table_name: 'users', rows_added: 2, rows_modified: 1, rows_deleted: 0 },
    { table_name: 'roles', rows_added: '0', rows_modified: '3', rows_deleted: '1' },
  ]);
  assert.deepEqual(m.get('users'), { added: 2, modified: 1, removed: 0 });
  assert.deepEqual(m.get('roles'), { added: 0, modified: 3, removed: 1 });
  assert.deepEqual(sumRows(m), { added: 2, modified: 4, removed: 1, total: 7 });
  assert.deepEqual(sumRows(rowCounts([])), { added: 0, modified: 0, removed: 0, total: 0 });
});
