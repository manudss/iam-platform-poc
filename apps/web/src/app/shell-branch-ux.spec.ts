import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { ApiClient } from './api';
import { Session } from './session';

describe('ApiClient.onDataMutation (accepted writes only)', () => {
  it('fires on an accepted write, never on a read or a failure', async () => {
    const seen: string[] = [];
    const c = new ApiClient('t', (async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response) as unknown as typeof fetch);
    c.onDataMutation = (m) => seen.push(`${m.method} ${m.path}`);
    await c.raw('POST', '/users', { id: 'u1' });
    await c.raw('GET', '/users');
    expect(seen).toEqual(['POST /users']);
    const failing = new ApiClient('t', (async () => ({ ok: false, status: 500, json: async () => ({ message: 'boom' }) }) as Response) as unknown as typeof fetch);
    failing.onDataMutation = (m) => seen.push(m.path);
    await expect(failing.raw('POST', '/users', {})).rejects.toThrow('boom');
    expect(seen).toEqual(['POST /users']); // the failed write never reached the hook
  });
});

describe('branch bar: changes chip, branch picker and pending-merge flash', () => {
  const access = { subject: 'demo-alice', admin: true, restricted: true, plugins: {} };
  const branchList = { default: 'main', branches: [{ name: 'main', commit: 'm1' }, { name: 'personal/demo-alice', commit: 'p1' }, { name: 'work-alpha', commit: 'w1' }] };
  let workspaceCalls = 0;
  const diff = { total: 3 };
  const boot = async () => {
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    workspaceCalls = 0; diff.total = 3;
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.user.set('demo-alice');
    s.api.raw = (async (_m: string, path: string) => {
      if (path === '/me/access') return { status: 200, data: access };
      if (path === '/workspace/personal') return { status: 200, data: { branch: 'personal/demo-alice', status: 'reused' } };
      if (path === '/versioning/branches') return { status: 200, data: branchList };
      if (path === '/workspace') { workspaceCalls++; return { status: 200, data: { branch: s.branch(), diff: { rows: { total: diff.total, added: diff.total, modified: 0, removed: 0 }, tables: [] } } }; }
      return { status: 200, data: [] };
    }) as never;
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/activation');
    await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    return { s, el: h.routeNativeElement as HTMLElement, h };
  };
  const settle = async (h: RouterTestingHarness) => { await new Promise((r) => setTimeout(r, 0)); h.detectChanges(); };

  it('shows the pending count on the Review & Apply chip and hides the native select visually', async () => {
    const { el } = await boot();
    const chip = el.querySelector('#review-apply') as HTMLButtonElement;
    expect(chip.classList.contains('pending')).toBe(true);
    expect(chip.textContent).toContain('3 changes pending');
    const hidden = el.querySelector('select[name=globalBranch]') as HTMLSelectElement;
    expect(hidden.classList.contains('sr-select')).toBe(true); // still in the DOM for automated scripts, not displayed
    expect(hidden.value).toBe('personal/demo-alice');
    expect(el.querySelector('#branch-picker-button')?.textContent).toContain('personal/demo-alice');
  });

  it('opens the picker with a fresh list, filters it and selects another branch', async () => {
    const { s, el, h } = await boot();
    (el.querySelector('#branch-picker-button') as HTMLButtonElement).click();
    await settle(h);
    const picker = el.querySelector('#branch-picker');
    expect(picker).not.toBeNull();
    expect(picker!.textContent).toContain('work-alpha');
    expect(picker!.textContent).toContain('refreshed just now');
    const input = picker!.querySelector('.psearch') as HTMLInputElement;
    input.value = 'alpha'; input.dispatchEvent(new Event('input'));
    await settle(h);
    expect([...el.querySelectorAll('#branch-list .bname')].map((x) => x.textContent)).toEqual(['work-alpha']);
    (el.querySelector('#branch-list .brow') as HTMLButtonElement).click();
    await settle(h);
    expect(s.branch()).toBe('work-alpha');
    expect(el.querySelector('#branch-picker')).toBeNull();
    expect(el.querySelector('#branch-picker-button')?.textContent).toContain('work-alpha');
  });

  it('opens and closes the floating review panel from the same chip', async () => {
    const { el, h } = await boot();
    const chip = el.querySelector('#review-apply') as HTMLButtonElement;
    chip.click();
    await settle(h);
    const panel = el.querySelector('#review-panel');
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains('reviewfloat')).toBe(true);
    expect(panel!.textContent).toContain('Apply personal/demo-alice to main');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    chip.click();
    await settle(h);
    expect(el.querySelector('#review-panel')).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  it('only a real pending branch change flashes the banner: simulations, bookkeeping and net-zero edits never do', async () => {
    const { s, el, h } = await boot();
    s.api.onDataMutation?.({ method: 'POST', path: '/policies/simulate', status: 200 }); // a simulation stores nothing
    await settle(h);
    expect(el.querySelector('#branch-flash')).toBeNull();
    const before = workspaceCalls;
    s.api.onDataMutation?.({ method: 'POST', path: '/workspace/apply', status: 200 }); // bookkeeping refreshes the counter only
    await settle(h);
    expect(workspaceCalls).toBeGreaterThan(before);
    expect(el.querySelector('#branch-flash')).toBeNull();
    diff.total = 0; // an edit that cancels another: the diff is empty again, there is nothing to merge
    s.api.onDataMutation?.({ method: 'PUT', path: '/users/u1', status: 200 });
    await settle(h);
    expect(el.querySelector('#branch-flash')).toBeNull();
    expect(el.querySelector('.fly-dot')).toBeNull();
    diff.total = 4;
    s.api.onDataMutation?.({ method: 'POST', path: '/users', status: 200 });
    await settle(h);
    const flash = el.querySelector('#branch-flash');
    expect(flash?.textContent).toContain('personal/demo-alice');
    expect(flash?.textContent).toContain('merged into main');
    expect(el.querySelector('.fly-dot')).not.toBeNull();
    expect((el.querySelector('#review-apply') as HTMLElement).classList.contains('pulse')).toBe(true);
    expect(el.querySelector('#review-apply')?.textContent).toContain('4 changes pending');
  });
});
