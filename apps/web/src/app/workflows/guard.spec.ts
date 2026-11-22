import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Session } from '../session';
import { workflowsEnabledGuard } from './guard';

describe('Workflows initial navigation', () => {
  const setup = () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const s = TestBed.inject(Session);
    vi.spyOn(s, 'loadAccess').mockResolvedValue({ subject: 'fixture', admin: true, restricted: true, plugins: {} });
    return s;
  };
  const guard = () => TestBed.runInInjectionContext(() => workflowsEnabledGuard({} as never, { url: '/workflows' } as never));
  it('opens the personal branch before the plugin read on a fresh deep link', async () => {
    const s = setup(); const calls: string[] = [];
    s.api.raw = (async (_m: string, path: string) => {
      calls.push(path);
      if (path === '/auth/me/admin-assurance') return { status: 200, data: { ok: true } };
      if (path === '/workspace/personal') return { status: 201, data: { branch: 'personal/alice', status: 'reused' } };
      expect(s.api.branch).toBe('personal/alice');
      return { status: 200, data: { plugins: [{ id: 'workflows-iga', enabled: true }] } };
    }) as never;
    expect(await guard()).toBe(true);
    expect(calls).toEqual(['/auth/me/admin-assurance', '/workspace/personal', '/plugins']);
    expect(s.branch()).toBe('personal/alice');
  });
  it('does not reopen or replace a selected/test branch', async () => {
    const s = setup(); s.enterBranchTest('review-me');
    s.api.raw = (async (_m: string, path: string) => {
      if (path === '/auth/me/admin-assurance') return { status: 200, data: { ok: true } };
      expect(path).toBe('/plugins'); expect(s.api.branch).toBe('review-me');
      return { status: 200, data: { plugins: [{ id: 'workflows-iga', enabled: true }] } };
    }) as never;
    expect(await guard()).toBe(true);
  });
  it('does not reuse another branch cached flag, including after a failed read', async () => {
    const s = setup(); s.selectBranch('branch-a');
    s.api.raw = (async () => ({ status: 200, data: { plugins: [{ id: 'workflows-iga', enabled: true }] } })) as never;
    expect(await s.refreshWorkflowsEnabled()).toBe(true);
    s.selectBranch('branch-b'); s.api.raw = (async () => { throw Error('offline'); }) as never;
    expect(await s.refreshWorkflowsEnabled()).toBe(false);
    s.api.raw = (async () => ({ status: 200, data: { plugins: [{ id: 'workflows-iga', enabled: false }] } })) as never;
    expect(await guard()).not.toBe(true);
  });
  it('reports a workspace failure rather than claiming the plugin is disabled', async () => {
    const s = setup(); s.api.raw = (async (_m: string, path: string) => { if (path === '/auth/me/admin-assurance') return { status: 200, data: { ok: true } }; throw Error('unavailable'); }) as never;
    const result = await guard();
    expect(TestBed.inject(Router).serializeUrl(result as never)).toBe('/plugins');
    expect(s.message()).toContain('working branch'); expect(s.tone()).toBe('error');
  });
  it('deduplicates concurrent workspace initialization', async () => {
    const s = setup(); let calls = 0;
    s.api.raw = (async () => { calls++; return { status: 201, data: { branch: 'personal/alice', status: 'reused' } }; }) as never;
    await Promise.all([s.ensurePersonalBranch(), s.ensurePersonalBranch()]);
    expect(calls).toBe(1);
  });
});
