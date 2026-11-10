import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { ApiClient, VersioningClient, cellText, shortHash } from './api';
import { DoltExplorer } from './dolt-explorer';

type Call = { method: string; path: string; body?: object; headers: Record<string, string> };

/** An ApiClient whose network is a fake: records calls and answers from a route table (no real API in this test). */
function fakeApi(routes: Record<string, (c: Call) => { status?: number; data: unknown }>) {
  const calls: Call[] = [];
  const api = new ApiClient('acme-demo');
  api.raw = (async (method: string, path: string, body?: object, headers: Record<string, string> = {}) => {
    const c = { method, path, body, headers }; calls.push(c);
    const key = Object.keys(routes).filter((k) => `${method} ${path}`.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`unexpected ${method} ${path}`);
    const r = routes[key](c); return { status: r.status ?? 200, data: r.data };
  }) as never;
  return { api, calls };
}

describe('VersioningClient', () => {
  it('sends the admin capability header, builds query strings and encodes names', async () => {
    const { api, calls } = fakeApi({ 'GET /versioning/diff': () => ({ data: { tables: [] } }), 'DELETE': () => ({ data: {} }) });
    const v = new VersioningClient(api); v.adminToken = 'tok-tok-tok-tok-tok';
    await v.diff('main', 'feat a', true); await v.deleteBranch('a b');
    expect(calls[0].path).toBe('/versioning/diff?from=main&to=feat%20a&three=1');
    expect(calls[0].headers['x-api-admin-token']).toBe('tok-tok-tok-tok-tok');
    expect(calls[1].path).toBe('/versioning/branches/a%20b');
  });
  it('turns a refusal (409, 4xx) into an error carrying the server message', async () => {
    const { api } = fakeApi({ 'POST /versioning/pulls/3/merge': () => ({ status: 409, data: { message: 'merge refused: 1 Separation-of-Duties violation(s)' } }) });
    await expect(new VersioningClient(api).mergePull(3)).rejects.toThrow('Separation-of-Duties');
  });
  it('formats cells and hashes', () => {
    expect(cellText(null)).toBe('NULL'); expect(cellText({ a: 1 })).toBe('{"a":1}'); expect(cellText(0)).toBe('0'); expect(cellText('x')).toBe('x');
    expect(shortHash('abcdefghijklmnop')).toBe('abcdefgh'); expect(shortHash(null)).toBe('');
  });
});

describe('DoltExplorer (rendering with a fake API)', () => {
  const mountHome = async (extra: Record<string, (c: Call) => { status?: number; data: unknown }> = {}) => {
    const r = routes({
      'GET /versioning/pulls': () => ({ data: { pullRequests: [
        { id: 3, title: 'Grant hr-partner', body: '', source: 'feat-a', target: 'main', status: 'open', author: 'demo-alice', createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null },
        { id: 2, title: 'Role rework part 1', body: '', source: 'work', target: 'main', status: 'merged', author: 'demo-bob', createdAt: new Date(Date.now() - 6 * 864e5).toISOString(), mergedAt: new Date(Date.now() - 5 * 864e5).toISOString(), mergeCommit: 'abc' } ] } }),
      ...extra });
    return mount(r);
  };

  it('home: stat cards, the three widgets and the workspace strip, all read from the API', async () => {
    const { f, el, c } = await mountHome({
      'GET /versioning/commits/': () => ({ data: { commit: 'm'.repeat(32), message: 'seed: demo data', author: 'demo-seed', date: new Date().toISOString(), parents: [], changes: [{ table: 'roles', from: null, kind: 'modified', dataChange: true, schemaChange: false, rows: { added: 1, modified: 0, removed: 0 } }] } }),
      'GET /versioning/pulls/3': () => ({ data: { pullRequest: { id: 3 }, comments: [], approvals: ['demo-bob'], requiredApprovals: 1, commits: [], diff: null, checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] } } }),
      'GET /versioning/diff?from=main&to=feat-a': () => ({ data: { from: 'main', to: 'feat-a', three: true, rows: { added: 3, modified: 0, removed: 0, total: 3 }, tables: [], schema: [] } }),
    });
    const stats = [...el.querySelectorAll('.stat')].map((x) => x.textContent ?? '');
    expect(stats.some((t) => t.includes('Branches') && t.includes('default main'))).toBe(true);
    expect(stats.some((t) => t.includes('Open pull request') && t.includes('all checks pass'))).toBe(true);
    expect(stats.some((t) => t.includes('Commits this week') && t.includes('Across all branches'))).toBe(true);
    expect(stats.some((t) => t.includes('Tables') && t.includes('main'))).toBe(true);
    const text = el.textContent ?? '';
    expect(text).toContain('Latest pull requests'); expect(text).toContain('Grant hr-partner'); expect(text).toContain('Checks passed');
    expect(text).toContain('Latest changes'); expect(text).toContain('seed: demo data'); expect(text).toContain('roles · +1');
    expect(text).toContain('Recently active branches'); expect(text).toContain('feat-a'); expect(text).toContain('2 ahead'); expect(text).toContain('3 rows');
    expect(text).toContain('Your workspace');
    // the widgets menu hides a section, and the choice survives a reload (localStorage)
    (el.querySelector('.ov-head .menu-wrap > button') as HTMLButtonElement).click(); f.detectChanges();
    const item = [...el.querySelectorAll('.ov-head .menu button')].find((b) => b.textContent?.includes('Recently active branches')) as HTMLButtonElement;
    item.click(); f.detectChanges();
    expect(el.textContent).not.toContain('Ordered by latest commit');
    expect(c['hiddenWidgets']().has('branches')).toBe(true);
    item.click(); f.detectChanges();
    expect(el.textContent).toContain('Ordered by latest commit');
    // a change row opens the commit in the History inspector
    const row = [...el.querySelectorAll('.w-row')].find((b) => b.textContent?.includes('seed: demo data')) as HTMLButtonElement;
    row.click(); await f.whenStable(); f.detectChanges();
    expect(c['tab']()).toBe('history');
  });
  it('home: the workspace strip offers the open pull request of the working branch', async () => {
    const { f, el, c } = await mountHome();
    c['workspace'].set({ branch: 'feat-a', protected: false, ahead: 2, behind: 1, changedRows: 3, openPr: 3 });
    f.detectChanges();
    const strip = el.querySelector('.ws-strip')?.textContent ?? '';
    expect(strip).toContain('feat-a'); expect(strip).toContain('3 changed rows'); expect(strip).toContain('Open PR #3');
    expect([...el.querySelectorAll('.ws-strip button')].some((b) => b.textContent?.includes('Review & apply'))).toBe(true);
  });

  const branches = { default: 'main', branches: [
    { name: 'main', commit: 'm'.repeat(32), committer: 'poc', date: '', message: 'seed', protected: true, default: true, aheadOfDefault: 0, behindDefault: 0 },
    { name: 'feat-a', commit: 'f'.repeat(32), committer: 'demo-alice', date: '', message: 'add role', protected: false, default: false, aheadOfDefault: 2, behindDefault: 1 }] };
  const col = (name: string, key = '') => ({ name, type: 'varchar', nullable: false, key });
  const tableOf = (ref: string) => ({ ref, kind: 'branch', table: 'roles', columns: [col('id', 'PRI'), col('label')], primaryKey: ['id'], total: 1, offset: 0, hasMore: false, rows: [{ id: 'a', label: 'A' }], createStatement: 'CREATE TABLE roles' });
  const routes = (extra: Record<string, (c: Call) => { status?: number; data: unknown }> = {}) => ({
    'GET /versioning/branches': () => ({ data: branches }), 'GET /versioning/tags': () => ({ data: { tags: [] } }),
    'GET /versioning/tables?': () => ({ data: { ref: 'main', kind: 'branch', tables: [{ name: 'roles', rows: 1 }] } }),
    'GET /versioning/tables/roles?ref=main': () => ({ data: tableOf('main') }), 'GET /versioning/tables/roles?ref=feat-a': () => ({ data: tableOf('feat-a') }),
    'GET /versioning/log': () => ({ data: { ref: 'main', commits: [{ commit: 'm'.repeat(32), author: 'demo-seed', date: new Date().toISOString(), message: 'seed: demo data', parents: [], refs: ['main'], merge: false }], hasMore: false } }),
    'GET /versioning/commits/': () => ({ data: { commit: 'm'.repeat(32), message: 'seed: demo data', author: 'demo-seed', date: new Date().toISOString(), parents: [], changes: [] } }),
    'GET /versioning/pulls/': () => ({ data: { pullRequest: {}, comments: [], approvals: [], requiredApprovals: 1, commits: [], diff: null, checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] } } }),
    'GET /versioning/diff?': () => ({ data: { from: 'main', to: 'feat-a', three: true, rows: { added: 0, modified: 0, removed: 0, total: 0 }, tables: [], schema: [] } }),
    'GET /versioning/pulls': () => ({ data: { pullRequests: [] } }), ...extra });
  const mount = async (r: ReturnType<typeof routes>) => {
    const { api, calls } = fakeApi(r);
    const f = TestBed.createComponent(DoltExplorer); f.componentInstance.api = api; f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); f.detectChanges();
    return { f, el: f.nativeElement as HTMLElement, calls, c: f.componentInstance as unknown as Record<string, any> };
  };
  const click = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }, el: HTMLElement, text: string) => {
    const b = [...el.querySelectorAll('button')].find((x) => x.textContent?.trim() === text); if (!b) throw new Error(`no button ${text}`);
    b.click(); await f.whenStable(); f.detectChanges();
  };

  it('lists branches; main is marked protected and cannot be deleted from the screen, others can', async () => {
    const { f, el } = await mount(routes());
    f.componentRef.setInput('section', 'branches'); await f.whenStable(); f.detectChanges();
    const cards = [...el.querySelectorAll('.branch-card')];
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain('protected'); expect(cards[0].textContent).not.toContain('Delete');
    expect(cards[0].textContent).toContain('Direct writes refused');
    expect(cards[1].textContent).toContain('2 ahead, 1 behind');
    // destructive actions live behind the overflow menu of the card
    const dots = [...cards[1].querySelectorAll('button')].find((b) => b.textContent?.trim() === '⋯') as HTMLButtonElement;
    expect(cards[1].textContent).not.toContain('Delete');
    dots.click(); f.detectChanges();
    expect(cards[1].textContent).toContain('Delete');
  });
  it('branches: the search filters the cards by name or last commit message', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'branches'); await f.whenStable(); f.detectChanges();
    c['branchSearch'].set('feat'); f.detectChanges();
    expect(el.querySelectorAll('.branch-card').length).toBe(1);
    c['branchSearch'].set('seed'); f.detectChanges();
    expect(el.querySelectorAll('.branch-card').length).toBe(1); // main, by its commit message
    c['branchSearch'].set(''); f.detectChanges();
    expect(el.querySelectorAll('.branch-card').length).toBe(2);
  });
  it('history: commits are grouped by day and the search filters by message, author or hash', async () => {
    const { f, el, c } = await mount(routes({
      'GET /versioning/log': () => ({ data: { ref: 'main', hasMore: true, commits: [
        { commit: 'a1'.padEnd(32, '0'), author: 'demo-seed', date: new Date().toISOString(), message: 'workflows: saved wf', parents: [], refs: ['main'], merge: false },
        { commit: 'b2'.padEnd(32, '0'), author: 'sarah-fontaine', date: new Date(Date.now() - 864e5).toISOString(), message: 'profile: edited demo-bob', parents: ['p'], refs: [], merge: false }] } }),
    }));
    f.componentRef.setInput('section', 'history'); await f.whenStable(); f.detectChanges();
    const days = [...el.querySelectorAll('.log-day')].map((x) => x.textContent?.trim());
    expect(days).toEqual(['Today', 'Yesterday']);
    expect(el.querySelector('ol.log')?.textContent).toContain('workflows: saved wf');
    c['histSearch'].set('sarah'); f.detectChanges();
    expect(el.querySelectorAll('ol.log li').length).toBe(1);
    expect(el.querySelector('ol.log')?.textContent).toContain('profile: edited demo-bob');
    c['histSearch'].set('b2'.padEnd(32, '0')); f.detectChanges();
    expect(el.querySelectorAll('ol.log li').length).toBe(1);
    c['histSearch'].set('zzz'); f.detectChanges();
    expect(el.querySelectorAll('ol.log li').length).toBe(0);
  });

  it('history: Rows opens a side inspector with the row changes of the commit', async () => {
    const { f, el, calls, c } = await mount(routes({
      'GET /versioning/commits/': () => ({ data: { commit: 'm'.repeat(32), message: 'roles: add auditor', author: 'demo-alice', date: new Date().toISOString(), parents: ['p'.repeat(32)], changes: [
        { table: 'roles', from: null, kind: 'modified', dataChange: true, schemaChange: false, rows: { added: 1, modified: 0, removed: 0 } },
        { table: 'policies', from: null, kind: 'modified', dataChange: false, schemaChange: true }] } }),
      'GET /versioning/diff/roles': () => ({ data: { table: 'roles', columns: ['id', 'label'], rows: [{ type: 'added', from: null, to: { id: 'auditor', label: 'Auditor' } }], truncated: false } }),
    }));
    f.componentRef.setInput('section', 'history'); await f.whenStable(); f.detectChanges();
    await click(f, el, 'Rows'); await f.whenStable(); f.detectChanges();
    const insp = el.querySelector('.hist-inspector');
    expect(insp?.textContent).toContain('roles: add auditor');
    expect(insp?.textContent).toContain('Row changes in roles');
    expect(insp?.textContent).toContain('auditor');
    // the diff is the two-dot diff against the first parent, not a navigation to Compare
    expect(calls.some((c) => c.path.startsWith('/versioning/diff/roles?from=' + 'p'.repeat(32)))).toBe(true);
    // the inspector sits beside the log (its own grid column), not below it
    expect(el.querySelector('.hist-cols.with-inspector > .hist-inspector')).toBeTruthy();
    // a schema-only table says so instead of loading rows (expand it: only data tables open by default)
    await c['toggleHistTableDiff']('policies'); f.detectChanges();
    expect(insp?.textContent).toContain('Schema change only');
    // the close button clears the selection
    (el.querySelector('.insp-close') as HTMLButtonElement).click(); f.detectChanges();
    expect(el.querySelector('.hist-inspector')).toBeNull();
  });

  it('styles: flat buttons keep a readable text color, at rest and on hover', () => {
    // regression guard for the unreadable workbench tabs and the hover of the 2-dot/3-dot toggle:
    // a flat button that overrides the global background must also set its color (both come from theme variables)
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    const css = read('./dolt-explorer.css') + read('./dolt-explorer-data.css');
    const wbTab = css.match(/\.wb-tab button\{([^}]*)\}/)?.[1] ?? '';
    expect(wbTab).toContain('background:none'); expect(wbTab).toContain('color:var(--ink)');
    const hover = css.match(/\.pill:not\(\.on\):hover[^,{]*,[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(hover).toContain('background:var(--row-hover)'); expect(hover).toContain('color:var(--ink)');
    // the data workbench: the grid is the scroll container, never the page (the 1fr column must be able to shrink)
    expect(css.match(/\.wb\{([^}]*)\}/)?.[1]).toContain('minmax(0,1fr)');
    expect(css.match(/\.data-grid\{([^}]*)\}/)?.[1]).toContain('overflow:auto');
  });

  it('offers row editing on an unprotected branch only, and read only on protected main', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges(); c['dataRef'] = 'main'; await c['openTable']('roles'); f.detectChanges();
    expect(el.textContent).toContain('read only'); expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit')).toBe(false);
    c['dataRef'] = 'feat-a'; await c['openTable']('roles'); f.detectChanges();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit')).toBe(true);
  });
  it('data workbench: tree, object tabs, row filter, sort, column chooser and status bar', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges();
    expect(el.querySelector('.wb-tree')?.textContent).toContain('TABLES (1)');
    expect(el.querySelector('.wb-tree')?.textContent).toContain('DOLT SYSTEM');
    await c['openTable']('roles'); f.detectChanges();
    expect(c['dataTabs']().length).toBe(1); expect(c['dataTabs']()[0]).toMatchObject({ kind: 'table', table: 'roles', ref: 'main' });
    expect(el.querySelector('.wb-tab')?.textContent).toContain('roles');
    expect(el.querySelector('.wb-tab')?.textContent).toContain('main');
    expect(el.querySelector('.wb-status')?.textContent).toContain('branch:');
    expect(el.querySelector('.wb-status')?.textContent).toContain('each edit is one commit');
    // filter rows
    c['rowFilter'].set('zzzz'); f.detectChanges();
    expect(el.querySelectorAll('.data-grid tbody tr').length).toBe(0);
    c['rowFilter'].set('a'); f.detectChanges();
    expect(el.querySelectorAll('.data-grid tbody tr').length).toBe(1);
    // column chooser hides a column
    c['toggleCol']('label'); f.detectChanges();
    expect(el.querySelector('.data-grid thead')?.textContent).not.toContain('label');
    c['toggleCol']('label'); f.detectChanges();
    // csv export builds a download from the visible rows
    const a = { href: '', download: '', click: () => {} } as unknown as HTMLAnchorElement;
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((t: string) => (t === 'a' ? a : create(t)));
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    c['exportCsv'](c['data']());
    expect(a.download).toBe('roles-main.csv');
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    // closing the active tab clears the grid
    c['closeDataTab'](0); f.detectChanges();
    expect(c['data']()).toBeNull(); expect(c['dataTabs']().length).toBe(0); expect(el.textContent).toContain('Pick a table on the left');
  });
  it('row history: past versions from dolt_history_ joined with the commit log, with restore filling the editor as a new commit', async () => {
    const hist = { mode: 'read', columns: ['id', 'label', 'commit_hash', 'committer', 'commit_date', '_commit_message'], rows: [
      { id: 'a', label: 'A2', commit_hash: 'h2'.padEnd(32, '2'), committer: 'demo-alice', commit_date: new Date().toISOString(), _commit_message: 'roles: rename A' },
      { id: 'a', label: 'A1', commit_hash: 'h1'.padEnd(32, '1'), committer: 'demo-seed', commit_date: new Date(Date.now() - 864e5).toISOString(), _commit_message: 'seed: demo data' }] };
    const { f, el, c, calls } = await mount(routes({ 'POST /versioning/sql': () => ({ data: hist }) }));
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges();
    c['dataRef'] = 'feat-a'; await c['openTable']('roles'); f.detectChanges();
    c['openRow']({ id: 'a', label: 'A2' }); await f.whenStable(); f.detectChanges();
    const card = el.querySelector('.row-history');
    expect(card?.textContent).toContain('every past version of a'); expect(card?.textContent).toContain('dolt_history_roles');
    expect(card?.textContent).toContain('label:'); expect(card?.textContent).toContain('A1'); expect(card?.textContent).toContain('A2');
    expect(card?.textContent).toContain('row created');
    // author and commit message come from the join with the commit log
    expect(card?.textContent).toContain('demo-alice'); expect(card?.textContent).toContain('roles: rename A');
    const histCall = calls.find((x) => x.path === '/versioning/sql');
    expect(JSON.stringify(histCall?.body)).toContain('dolt_commits');
    // restore an old version: a row tab opens with its values and a restore commit message
    const restore = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Restore') as HTMLButtonElement;
    restore.click(); await f.whenStable(); f.detectChanges();
    expect(c['activeRowTab']()?.key).toEqual({ id: 'a' }); expect(c['formFields']['label']).toBe('A1');
    expect(el.querySelector<HTMLInputElement>('input[name=em]')?.value).toContain('restore a to');
  });
  it('data workbench: the tree branch selector reloads only the tables list - open tabs keep their own branch', async () => {
    const { f, el, c } = await mount(routes({
      'GET /versioning/tables?ref=feat-a': () => ({ data: { ref: 'feat-a', kind: 'branch', tables: [{ name: 'roles', rows: 5 }] } }),
    }));
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges();
    await c['openTable']('roles'); f.detectChanges();
    expect(c['dataTabs']().length).toBe(1);
    // switch the tree branch: the tables list reloads, the open tab is untouched and still bound to main
    const sel = el.querySelector('select[name=dr]') as HTMLSelectElement;
    expect(sel).toBeTruthy(); // the branch selector lives in the tree now
    sel.value = 'feat-a'; sel.dispatchEvent(new Event('change')); await f.whenStable(); f.detectChanges();
    expect(c['dataRef']).toBe('feat-a');
    expect(c['dataTabs']().length).toBe(1); expect(c['dataTabs']()[0]).toMatchObject({ kind: 'table', table: 'roles', ref: 'main' });
    expect(el.querySelector('.wb-tab')?.textContent).toContain('main');
    // opening the same table on the new branch makes a SECOND tab; switching between them loads each branch's rows
    await c['openTable']('roles'); f.detectChanges();
    expect(c['dataTabs']().length).toBe(2);
    expect(c['dataTabs']()[1]).toMatchObject({ kind: 'table', table: 'roles', ref: 'feat-a' });
    expect(c['data']()?.ref).toBe('feat-a');
    c['switchDataTab'](0); await f.whenStable(); f.detectChanges();
    expect(c['data']()?.ref).toBe('main');
    expect(el.querySelector('.wb-tab.on')?.textContent).toContain('main');
  });
  it('row edit: opens its own tab with a separated commit section, and committing closes it back to a refreshed table tab', async () => {
    const hist = { mode: 'read', columns: ['id', 'label', 'commit_hash', 'committer', 'commit_date', '_commit_message'], rows: [
      { id: 'a', label: 'A', commit_hash: 'h1'.padEnd(32, '1'), committer: 'demo-seed', commit_date: new Date().toISOString(), _commit_message: 'seed' }] };
    const { f, el, c, calls } = await mount(routes({
      'POST /versioning/sql': () => ({ data: hist }),
      'POST /versioning/tables/roles/edit': () => ({ data: { commit: 'c'.repeat(32) } }),
    }));
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges();
    c['dataRef'] = 'feat-a'; await c['openTable']('roles'); f.detectChanges();
    // Edit on a grid row opens a row tab next to the table tab
    const edit = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit') as HTMLButtonElement;
    edit.click(); await f.whenStable(); f.detectChanges();
    expect(c['dataTabs']().length).toBe(2);
    expect(c['activeRowTab']()).toMatchObject({ table: 'roles', ref: 'feat-a', key: { id: 'a' } });
    expect(el.querySelector('.wb-tab.on')?.textContent).toContain('a');
    // the commit message is a separated section, not one of the column fields
    const box = el.querySelector('.commit-box');
    expect(box?.textContent).toContain('Commit on feat-a');
    expect(box?.querySelector('input[name=em]')).toBeTruthy();
    expect(el.querySelector('[data-edit-field=label]')).toBeTruthy();
    expect(el.querySelector('.row-history')?.textContent).toContain('demo-seed');
    // commit & close: the row tab goes away, the table tab is back and refreshed
    c['formFields']['label'] = 'A2'; c['editMessage'] = 'roles: fix label';
    await c['saveEdit'](); await f.whenStable(); f.detectChanges();
    expect(c['dataTabs']().length).toBe(1); expect(c['activeRowTab']()).toBeNull();
    expect(c['data']()?.ref).toBe('feat-a');
    expect(c['note']()).toContain('Committed');
    const editCall = calls.find((x) => x.path === '/versioning/tables/roles/edit');
    expect(JSON.stringify(editCall?.body)).toContain('roles: fix label');
  });
  it('compare: summary chips, per-table row diffs and a column-level schema diff', async () => {
    const diff = { from: 'main', to: 'feat-a', three: true, rows: { added: 1, modified: 1, removed: 1, total: 3 },
      tables: [{ table: 'roles', from: null, kind: 'modified', dataChange: true, schemaChange: true, rows: { added: 1, modified: 1, removed: 1 } }],
      schema: [{ table: 'roles', from: 'CREATE TABLE `roles` (\n  `id` varchar(64) NOT NULL,\n  `label` varchar(120) NULL,\n  PRIMARY KEY (`id`)\n)', to: 'CREATE TABLE `roles` (\n  `id` varchar(64) NOT NULL,\n  `label` varchar(254) NULL,\n  PRIMARY KEY (`id`)\n)' }] };
    const rows = { table: 'roles', columns: ['id', 'label'], rows: [{ type: 'added', from: null, to: { id: 'b', label: 'B' } }], truncated: false };
    const { f, el, c } = await mount(routes({
      'GET /versioning/diff?from=main&to=feat-a': () => ({ data: diff }),
      'GET /versioning/diff/roles': () => ({ data: rows }),
    }));
    f.componentRef.setInput('section', 'compare'); await f.whenStable(); f.detectChanges();
    c['from'] = 'main'; c['to'] = 'feat-a'; await c['compare'](); f.detectChanges();
    const summary = el.querySelector('.cmp-summary')?.textContent ?? '';
    expect(summary).toContain('1 tables'); expect(summary).toContain('+1'); expect(summary).toContain('−1'); expect(summary).toContain('1 schema change');
    expect(el.querySelector('.table-diff')?.textContent).toContain('roles');
    expect(el.querySelector('.table-diff tr.add')?.textContent).toContain('B');
    // schema tab: column-level diff, old value struck, new one kept
    c['compareTab'].set('schema'); f.detectChanges();
    const schema = el.textContent ?? '';
    expect(schema).toContain('Schema: roles'); expect(schema).toContain('label');
    expect(schema).toContain('varchar(120) NULL'); expect(schema).toContain('varchar(254) NULL');
    expect(schema).not.toContain('PRIMARY KEY');
  });

  it('shows a merge refusal reason and keeps Merge disabled when checks fail', async () => {
    const detail = { pullRequest: { id: 7, title: 'bob approves', body: '', source: 'sod', target: 'main', status: 'open', author: 'demo-alice', createdAt: '', mergedAt: null, mergeCommit: null }, comments: [], approvals: [], requiredApprovals: 0, commits: [], diff: { from: 'main', to: 'sod', three: true, tables: [], schema: [] },
      checks: { mergeable: false, reasons: ['1 Separation-of-Duties violation(s)'], conflicts: 0, violations: [{ identity: 'demo-bob', roleA: 'payment-creator', roleB: 'payment-approver' }] } };
    const { f, el, c } = await mount(routes({ 'GET /versioning/pulls/7': () => ({ data: detail }) }));
    await c['showPull'](7); c['tab'].set('pulls'); f.detectChanges();
    expect(el.textContent).toContain('Cannot be merged'); expect(el.textContent).toContain('demo-bob would have payment-creator and payment-approver');
    const merge = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Merge pull request') as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
  });
  it('allows author approval by default and follows the configured protection', async () => {
    const detail = { viewer: 'demo-alice', preventSelfApproval: false, pullRequest: { id: 9, author: 'demo-alice', status: 'open', source: 'work', target: 'main' }, comments: [], approvals: [], requiredApprovals: 0, commits: [], diff: null, checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] } };
    const { f, el, c } = await mount(routes({ 'GET /versioning/pulls/9': () => ({ data: detail }) }));
    await c['showPull'](9); c['tab'].set('pulls'); f.detectChanges();
    const approve = () => [...el.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Approve') as HTMLButtonElement;
    expect(approve().disabled).toBe(false);
    detail.preventSelfApproval = true; await c['showPull'](9); f.detectChanges();
    expect(approve().disabled).toBe(true); expect(el.textContent).toContain('someone else has to approve');
  });
  it('pull requests: status pills with counts, search, and per-PR badges from the detail', async () => {
    const list = { pullRequests: [
      { id: 3, title: 'Grant hr-partner', body: '', source: 'feat-a', target: 'main', status: 'open', author: 'demo-alice', createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null },
      { id: 2, title: 'Role rework part 1', body: '', source: 'work', target: 'main', status: 'merged', author: 'demo-bob', createdAt: new Date(Date.now() - 6 * 864e5).toISOString(), mergedAt: new Date(Date.now() - 5 * 864e5).toISOString(), mergeCommit: 'abc123456789' }] };
    const detail3 = { pullRequest: list.pullRequests[0], comments: [], approvals: ['demo-bob'], requiredApprovals: 1, commits: [], checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] }, diff: { from: 'main', to: 'feat-a', three: true, rows: { added: 9, modified: 0, removed: 1, total: 10 }, tables: [], schema: [] } };
    const detail2 = { pullRequest: list.pullRequests[1], comments: [], approvals: [], requiredApprovals: 1, commits: [], checks: null, diff: null };
    const { f, el, c } = await mount(routes({
      'GET /versioning/pulls/': (cc) => cc.path.includes('/pulls/3') ? ({ data: detail3 }) : ({ data: detail2 }),
      'GET /versioning/pulls': () => ({ data: list }) }));
    f.componentRef.setInput('section', 'pulls'); await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); f.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('Open 1'); expect(text).toContain('Merged 1');
    expect(text).toContain('Grant hr-partner'); expect(text).not.toContain('Role rework part 1'); // open pill by default
    expect(text).toContain('checks pass'); expect(text).toContain('approved'); expect(text).toContain('+9 \u22121 rows');
    c['prStatus'].set('all'); f.detectChanges();
    expect(el.textContent).toContain('Role rework part 1'); expect(el.textContent).toContain('squash commit');
    c['prSearch'].set('zzzz'); f.detectChanges();
    expect(el.textContent).toContain('No pull request in this view');
  });
  it('pull request detail: steps, checks card and rows tab', async () => {
    const diff = { from: 'main', to: 'feat-a', three: true, rows: { added: 1, modified: 0, removed: 1, total: 2 }, tables: [{ table: 'roles', from: null, kind: 'modified', dataChange: true, schemaChange: false, rows: { added: 1, modified: 0, removed: 1 } }], schema: [] };
    const rows = { table: 'roles', columns: ['id', 'label'], rows: [{ type: 'added', from: null, to: { id: 'b', label: 'B' } }], truncated: false };
    const detail = { pullRequest: { id: 5, title: 'Grant hr-partner', body: 'Adds the role.', source: 'feat-a', target: 'main', status: 'open', author: 'demo-alice', createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null },
      comments: [{ id: 1, author: 'demo-bob', kind: 'approve', body: 'LGTM', createdAt: new Date().toISOString() }], approvals: ['demo-bob'], requiredApprovals: 1,
      commits: [{ commit: 'c'.repeat(32), author: 'demo-alice', date: new Date().toISOString(), message: 'grant hr-partner' }], diff, checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] } };
    const { f, el, c } = await mount(routes({ 'GET /versioning/pulls/5': () => ({ data: detail }), 'GET /versioning/diff/roles': () => ({ data: rows }) }));
    await c['showPull'](5); c['tab'].set('pulls'); f.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('wants to merge 1 commit into'); expect(text).toContain('Able to merge.'); expect(text).toContain('Separation of duties respected');
    expect(text).toContain('approved by demo-bob'); expect(text).toContain('1 of 1 required');
    expect(text).toContain('LGTM');
    const merge = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Merge pull request') as HTMLButtonElement;
    expect(merge.disabled).toBe(false);
    c['prTab'].set('rows'); f.detectChanges();
    expect(el.querySelector('.table-diff tr.add')?.textContent).toContain('B');
  });
  it('pull requests: the new-PR form hides the open detail, and opening a PR closes the form', async () => {
    const detail = { pullRequest: { id: 5, title: 'Grant hr-partner', body: '', source: 'feat-a', target: 'main', status: 'open', author: 'demo-alice', createdAt: new Date().toISOString(), mergedAt: null, mergeCommit: null },
      comments: [], approvals: [], requiredApprovals: 1, commits: [], diff: null, checks: { mergeable: true, reasons: [], conflicts: 0, violations: [] } };
    const { f, el, c } = await mount(routes({ 'GET /versioning/pulls/5': () => ({ data: detail }) }));
    f.componentRef.setInput('section', 'pulls'); await f.whenStable(); f.detectChanges();
    await c['showPull'](5); f.detectChanges();
    expect(el.querySelector('.pr-detail')).toBeTruthy();
    // opening the form hides the previously selected pull request
    const newBtn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('New pull request')) as HTMLButtonElement;
    newBtn.click(); f.detectChanges();
    expect(el.querySelector('.pr-detail')).toBeFalsy();
    expect(el.textContent).toContain('New pull request');
    // and opening a pull request closes the form again
    await c['showPull'](5); f.detectChanges();
    expect(el.querySelector('.pr-detail')).toBeTruthy();
    expect(c['prCreateOpen']).toBe(false);
  });
  it('sql console: query tabs keep their text, and save query stores to localStorage', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'sql'); await f.whenStable(); f.detectChanges();
    expect(el.querySelector('.wb-tab')?.textContent).toContain('Query 1');
    c['sqlText'] = 'select * from roles';
    c['addSqlTab'](); f.detectChanges();
    expect(c['sqlText']).toBe(''); expect(el.textContent).toContain('Query 2');
    c['sqlText'] = 'select * from dolt_log';
    c['switchSqlTab'](0); f.detectChanges();
    expect(c['sqlText']).toBe('select * from roles');
    // save query
    vi.spyOn(window, 'prompt').mockReturnValue('SoD conflicts');
    c['saveQuery']();
    expect(c['savedQueries']().map((q: { name: string }) => q.name)).toContain('SoD conflicts');
    expect(localStorage.getItem('dolt-saved-queries')).toContain('select * from roles');
    // mode pills switch read/write
    const write = [...el.querySelectorAll('.pill')].find((b) => b.textContent?.trim() === 'Write') as HTMLButtonElement;
    write.click(); f.detectChanges();
    expect(c['sqlMode']).toBe('write'); expect(el.textContent).toContain('Preview changes');
    vi.restoreAllMocks();
  });
  it('sql console: branch and mode are per-tab and restored when switching tabs', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'sql'); await f.whenStable(); f.detectChanges();
    const branch = () => el.querySelector('select[name=sr]') as HTMLSelectElement;
    const setBranch = (v: string) => { const s = branch(); s.value = v; s.dispatchEvent(new Event('change')); f.detectChanges(); };
    // tab 1: pick feat-a, stay in read mode, run-less result stays empty
    setBranch('feat-a');
    expect(c['sqlRef']).toBe('feat-a');
    // new tab inherits the active tab's branch and mode
    c['addSqlTab'](); f.detectChanges();
    expect(c['sqlRef']).toBe('feat-a'); expect(c['sqlMode']).toBe('read');
    // switch this tab to main + write
    setBranch('main');
    const write = [...el.querySelectorAll('.pill')].find((b) => b.textContent?.trim() === 'Write') as HTMLButtonElement;
    write.click(); f.detectChanges();
    expect(c['sqlRef']).toBe('main'); expect(c['sqlMode']).toBe('write');
    // back to tab 1: its own branch and mode are restored
    c['switchSqlTab'](0); await f.whenStable(); f.detectChanges();
    expect(c['sqlRef']).toBe('feat-a'); expect(c['sqlMode']).toBe('read');
    expect(branch().value).toBe('feat-a');
    // and forward again: tab 2 kept main + write
    c['switchSqlTab'](1); f.detectChanges();
    expect(c['sqlRef']).toBe('main'); expect(c['sqlMode']).toBe('write');
    // closing the active tab restores the remaining tab's state
    c['closeSqlTab'](1); f.detectChanges();
    expect(c['sqlActiveTab']()).toBe(0); expect(c['sqlRef']).toBe('feat-a'); expect(c['sqlMode']).toBe('read');
  });
  it('sql console: clicking an application table in the tree fills the editor like a system table', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'sql'); await f.whenStable(); f.detectChanges();
    const item = [...el.querySelectorAll('.tree-item')].find((b) => b.textContent?.trim().startsWith('roles')) as HTMLButtonElement;
    expect(item).toBeTruthy();
    item.click(); await f.whenStable(); f.detectChanges();
    expect(c['tab']()).toBe('sql');
    expect(c['sqlText']).toBe('select * from roles limit 50');
    expect(c['sqlMode']).toBe('read');
    // on the data view the same tree still opens the data grid
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges();
    const item2 = [...el.querySelectorAll('.tree-item')].find((b) => b.textContent?.trim().startsWith('roles')) as HTMLButtonElement;
    item2.click(); await f.whenStable(); f.detectChanges();
    expect(c['data']()?.table).toBe('roles');
  });
  it('sql dry run: banner plus per-table row samples', async () => {
    const res = { mode: 'write', dryRun: true, statements: 1, affectedRows: 1, changes: [{ table: 'roles', kind: 'modified', dataChange: true, schemaChange: false }], samples: { roles: { columns: ['id', 'label'], rows: [{ type: 'added', from: null, to: { id: 'x', label: 'X' } }] } } };
    const { f, el, c } = await mount(routes({ 'POST /versioning/sql': () => ({ data: res }) }));
    f.componentRef.setInput('section', 'sql'); await f.whenStable(); f.detectChanges();
    c['sqlMode'] = 'write'; c['sqlRef'] = 'feat-a'; c['sqlText'] = "insert into roles values ('x','X',false)"; await c['runSql'](true); f.detectChanges();
    expect(el.querySelector('.sql-dryrun')?.textContent).toContain('Preview only');
    expect(el.querySelector('.table-diff tr.add')?.textContent).toContain('X');
  });
  it('shows server errors in the status line instead of failing silently', async () => {
    const { f, el, c } = await mount(routes({ 'POST /versioning/sql': () => ({ status: 403, data: { message: 'branch main is protected: open a pull request instead' } }) }));
    c['sqlMode'] = 'write'; c['sqlRef'] = 'main'; c['sqlText'] = "insert into roles values ('x','x',false)"; await c['runSql'](false); f.detectChanges();
    expect(el.querySelector('.msg')?.textContent).toContain('protected');
  });

  it('sanitizes branch names as they are typed: spaces become _, refused characters are dropped', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'branches'); await f.whenStable(); f.detectChanges();
    expect(c['sanitizeRefName']('my change!')).toBe('my_change');
    expect(c['sanitizeRefName']('  lead space')).toBe('lead_space');
    await click(f, el, '+ New branch');
    const input = el.querySelector('input[name=nb]') as HTMLInputElement;
    input.value = 'on_boarding ok'; input.dispatchEvent(new Event('input')); await f.whenStable(); f.detectChanges();
    expect(c['newBranch']).toBe('on_boarding_ok');
  });
  it('branch form: an invalid name shows the exact reason next to the field and never calls the API', async () => {
    const { f, el, c, calls } = await mount(routes());
    f.componentRef.setInput('section', 'branches'); await f.whenStable(); f.detectChanges();
    await click(f, el, '+ New branch'); c['newBranch'] = 'bad..name'; f.detectChanges();
    await c['createBranch'](); f.detectChanges();
    expect(c['newBranchErr']()).toBe('No two dots in a row.');
    expect(calls.some((x) => x.path.startsWith('/versioning/branches') && x.method === 'POST')).toBe(false);
    const err = el.querySelector('.field-err');
    expect(err?.textContent).toContain('No two dots');
    expect(el.querySelector('input[name=nb]')?.getAttribute('aria-invalid')).toBe('true');
  });
  it('branch form: a server-side name refusal is mirrored next to the field, not only in the banner', async () => {
    const { f, el, c } = await mount(routes({ 'POST /versioning/branches': () => ({ status: 400, data: { message: 'invalid branch name (letters, digits, . _ - ; max 63)' } }) }));
    f.componentRef.setInput('section', 'branches'); await f.whenStable(); f.detectChanges();
    await click(f, el, '+ New branch'); c['newBranch'] = 'on_boarding'; f.detectChanges();
    await c['createBranch'](); f.detectChanges();
    expect(c['newBranchErr']()).toContain('invalid branch name');
    expect(c['note']()).toBe('');
    expect(el.querySelector('.field-err')?.textContent).toContain('invalid branch name');
  });
  it('history inspector: the same inline validation guards branch/tag names', async () => {
    const { f, c, calls } = await mount(routes());
    f.componentRef.setInput('section', 'history'); await f.whenStable(); f.detectChanges();
    c['actionName'] = '-bad';
    await c['branchFrom']('a'.repeat(32)); f.detectChanges();
    expect(c['actionNameErr']()).toBe('Start with a letter or a digit.');
    expect(calls.some((x) => x.method === 'POST' && x.path.startsWith('/versioning/branches'))).toBe(false);
  });
  it('pull request form: an empty title shows an inline error and never calls the API', async () => {
    const { f, el, c, calls } = await mount(routes());
    f.componentRef.setInput('section', 'pulls'); await f.whenStable(); f.detectChanges();
    await click(f, el, '+ New pull request'); c['prForm'] = { title: '  ', body: '', source: 'feat-a', target: 'main' }; f.detectChanges();
    await c['openPull'](); f.detectChanges();
    expect(c['prTitleErr']()).toBe('A title is required.');
    expect(calls.some((x) => x.method === 'POST' && x.path === '/versioning/pulls')).toBe(false);
    expect(el.querySelector('#pti-err')?.textContent).toContain('title is required');
  });

  it('compare: named diff modes, and a banner when the base has moved ahead in Branch changes view', async () => {
    const shared = { commit: 's'.repeat(32), author: 'demo-seed', date: new Date().toISOString(), message: 'seed', parents: [], refs: [], merge: false };
    const { f, el, c } = await mount(routes({
      'GET /versioning/log?ref=main': () => ({ data: { ref: 'main', hasMore: false, commits: [{ ...shared, commit: 'm'.repeat(32), message: 'main moved' }, shared] } }),
      'GET /versioning/log?ref=feat-a': () => ({ data: { ref: 'feat-a', hasMore: false, commits: [shared] } }),
    }));
    f.componentRef.setInput('section', 'compare'); await f.whenStable(); f.detectChanges();
    c['from'] = 'main'; c['to'] = 'feat-a'; await c['compare'](); f.detectChanges();
    const pills = [...el.querySelectorAll('.pill')].map((x) => x.textContent?.trim());
    expect(pills).toEqual(['Branch changes', 'All changes']);
    expect((el.querySelector('.pill.on') as HTMLElement)?.textContent).toContain('Branch changes'); // three-dot default
    expect(el.textContent).toContain('shows what feat-a changed since it diverged from main');
    expect(c['compareBehind']()).toBe(1);
    expect(el.querySelector('.msg')?.textContent).toContain('main has moved ahead by 1 commit');
    // All changes shows everything, so the banner goes away
    await click(f, el, 'All changes');
    expect(el.querySelector('.msg')?.textContent ?? '').not.toContain('moved ahead');
  });

  it('follows the route section, and announces its own jumps so the address can follow', async () => {
    const { api } = fakeApi(routes());
    const f = TestBed.createComponent(DoltExplorer); f.componentRef.setInput('api', api); f.componentRef.setInput('section', 'history');
    const seen: string[] = []; f.componentInstance.navigate.subscribe((t) => seen.push(t));
    f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 0)); f.detectChanges();
    const c = f.componentInstance as unknown as Record<string, any>;
    expect(c['tab']()).toBe('history');
    c['compareWithDefault']('feat-a');
    expect(c['tab']()).toBe('compare'); expect(seen).toContain('compare');
    f.componentRef.setInput('section', 'sql'); await f.whenStable();
    expect(c['tab']()).toBe('sql');
  });
});
