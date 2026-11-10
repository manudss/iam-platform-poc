import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ReviewPage } from './review';

const json = (body: unknown) => ({ ok: true, status: 200, data: body });

describe('Review changes page', () => {
  it('shows rows before (red) and after (green) per table, with row counts', async () => {
    const calls: string[] = [];
    const api = { raw: async (_m: string, path: string) => {
      calls.push(path);
      if (path.startsWith('/versioning/diff/users')) return json({ table: 'users', columns: ['id', 'name'], truncated: false, rows: [
        { type: 'modified', from: { id: 1, name: 'Al' }, to: { id: 1, name: 'Alice' } }, { type: 'added', from: null, to: { id: 2, name: 'Bob' } }] });
      return json({ from: 'main', to: 'demo-alice', three: true, rows: { added: 1, modified: 1, removed: 0, total: 2 }, schema: [],
        tables: [{ table: 'users', from: 'users', kind: 'modified', dataChange: true, schemaChange: false, rows: { added: 1, modified: 1, removed: 0 } }] });
    } };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: { branch: () => 'demo-alice', api, adminToken: () => '' } }] });
    const f = TestBed.createComponent(ReviewPage); for (let i = 0; i < 5; i++) { f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 10)); } f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(calls.some((c) => c.includes('three=1') && c.includes('from=main') && c.includes('to=demo-alice'))).toBe(true);
    expect(el.querySelector('#review-total')?.textContent).toContain('2 rows changed in 1 table');
    expect(el.querySelectorAll('tr.del').length).toBe(1); expect(el.querySelectorAll('tr.add').length).toBe(2);
    expect(el.querySelector('tr.del')?.textContent).toContain('Al'); expect(el.querySelector('td.chg')?.textContent).toContain('Al');
  });
  it('offers Apply and Open a pull request, wired to the guarded flows', async () => {
    const calls: { m: string; path: string; body: unknown }[] = [];
    const api = { raw: async (m: string, path: string, body?: unknown) => {
      calls.push({ m, path, body });
      if (path.startsWith('/versioning/diff?')) return json({ from: 'main', to: 'demo-alice', three: true, rows: { added: 1, modified: 0, removed: 0, total: 1 }, schema: [],
        tables: [{ table: 'users', from: 'users', kind: 'modified', dataChange: true, schemaChange: false, rows: { added: 1, modified: 0, removed: 0 } }] });
      if (path.startsWith('/versioning/diff/users')) return json({ table: 'users', columns: ['id'], truncated: false, rows: [{ type: 'added', from: null, to: { id: 2 } }] });
      if (path === '/versioning/branches') return json({ default: 'main', branches: [{ name: 'main', commit: 'aaa', protected: true }, { name: 'demo-alice', commit: 'bbb', protected: false }] });
      if (path === '/workspace/apply') return json({ applied: true, commit: 'ccc' });
      if (path === '/versioning/pulls') return json({ id: 7, title: 't', source: 'demo-alice', target: 'main', status: 'open' });
      return json({});
    } };
    const session = { branch: () => 'demo-alice', api, adminToken: () => '', branchEpoch: { update: (fn: (x: number) => number) => fn(0) } };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: session }] });
    const f = TestBed.createComponent(ReviewPage); for (let i = 0; i < 5; i++) { f.detectChanges(); await f.whenStable(); await new Promise((r) => setTimeout(r, 10)); } f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    const applyBtn = [...el.querySelectorAll('#review-actions button')].find((b) => b.textContent?.includes('Apply demo-alice into main')) as HTMLButtonElement;
    const prBtn = [...el.querySelectorAll('#review-actions button')].find((b) => b.textContent?.includes('Open a pull request')) as HTMLButtonElement;
    expect(applyBtn).toBeTruthy(); expect(prBtn).toBeTruthy();
    // open a pull request: source is the working branch, target main
    prBtn.click(); await f.whenStable(); f.detectChanges();
    const prCall = calls.find((c) => c.m === 'POST' && c.path === '/versioning/pulls');
    expect(prCall?.body).toMatchObject({ source: 'demo-alice', target: 'main' });
    expect(el.textContent).toContain('Pull request #7 opened');
    // apply: the same guarded endpoint as the toolbar, with confirm and the branch head
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    applyBtn.click(); await f.whenStable(); f.detectChanges();
    const applyCall = calls.find((c) => c.m === 'POST' && c.path === '/workspace/apply');
    expect(applyCall?.body).toMatchObject({ confirm: true, expectedHead: 'bbb' });
    expect(el.textContent).toContain('Applied demo-alice into main: ccc');
    vi.restoreAllMocks();
  });
  it('explains that main has nothing to review', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: { branch: () => 'main', api: {}, adminToken: () => '' } }] });
    const f = TestBed.createComponent(ReviewPage); f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('main is read only');
  });
});
