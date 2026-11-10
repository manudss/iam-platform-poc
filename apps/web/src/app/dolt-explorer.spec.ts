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

  it('home: overview cards, activity feed and the workspace panel, all read from the API', async () => {
    const { el } = await mountHome();
    const stats = [...el.querySelectorAll('.stat')].map((x) => x.textContent ?? '');
    expect(stats.some((t) => t.includes('Branches') && t.includes('main'))).toBe(true);
    expect(stats.some((t) => t.includes('Open pull request') && t.includes('awaiting merge'))).toBe(true);
    expect(stats.some((t) => t.includes('Tables') && t.includes('main'))).toBe(true);
    const feed = el.querySelector('.feed')?.textContent ?? '';
    expect(feed).toContain('seed: demo data');
    expect(feed).toContain('opened PR #3');
    expect(feed).toContain('merged');
    const ws = el.textContent ?? '';
    expect(ws).toContain('Your workspace'); expect(ws).toContain('protected');
    expect(ws).toContain('Jump to');
  });
  it('home: the workspace panel offers the open pull request of the working branch', async () => {
    const { f, el, c } = await mountHome();
    c['workspace'].set({ branch: 'feat-a', protected: false, ahead: 2, behind: 1, changedRows: 3, openPr: 3 });
    f.detectChanges();
    const text = el.textContent ?? '';
    expect(text).toContain('feat-a'); expect(text).toContain('3 changed rows'); expect(text).toContain('Open PR #3');
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.includes('Review & apply to main'))).toBe(true);
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
  it('offers row editing on an unprotected branch only, and read only on protected main', async () => {
    const { f, el, c } = await mount(routes());
    f.componentRef.setInput('section', 'data'); await f.whenStable(); f.detectChanges(); c['dataRef'] = 'main'; await c['openTable']('roles'); f.detectChanges();
    expect(el.textContent).toContain('read only'); expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit')).toBe(false);
    c['dataRef'] = 'feat-a'; await c['openTable']('roles'); f.detectChanges();
    expect([...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Edit')).toBe(true);
  });
  it('shows a merge refusal reason and keeps Merge disabled when checks fail', async () => {
    const detail = { pullRequest: { id: 7, title: 'bob approves', body: '', source: 'sod', target: 'main', status: 'open', author: 'demo-alice', createdAt: '', mergedAt: null, mergeCommit: null }, comments: [], approvals: [], requiredApprovals: 0, commits: [], diff: { from: 'main', to: 'sod', three: true, tables: [], schema: [] },
      checks: { mergeable: false, reasons: ['1 Separation-of-Duties violation(s)'], conflicts: 0, violations: [{ identity: 'demo-bob', roleA: 'payment-creator', roleB: 'payment-approver' }] } };
    const { f, el, c } = await mount(routes({ 'GET /versioning/pulls/7': () => ({ data: detail }) }));
    await c['showPull'](7); c['tab'].set('pulls'); f.detectChanges();
    expect(el.textContent).toContain('Cannot be merged'); expect(el.textContent).toContain('demo-bob would have payment-creator and payment-approver');
    const merge = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Merge') as HTMLButtonElement;
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
  it('shows server errors in the status line instead of failing silently', async () => {
    const { f, el, c } = await mount(routes({ 'POST /versioning/sql': () => ({ status: 403, data: { message: 'branch main is protected: open a pull request instead' } }) }));
    c['sqlMode'] = 'write'; c['sqlRef'] = 'main'; c['sqlText'] = "insert into roles values ('x','x',false)"; await c['runSql'](false); f.detectChanges();
    expect(el.querySelector('.msg')?.textContent).toContain('protected');
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
