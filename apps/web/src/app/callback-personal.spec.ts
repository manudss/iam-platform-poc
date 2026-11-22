import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { CallbackPage } from './login';
import { Session } from './session';

describe('personal landing and same-account callback', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());
  for (const subject of [null, 'fixture-user', 'different-user']) it('does not initialize admin data for callback ' + subject, async () => {
    sessionStorage.setItem('iam.return', subject ? '/users' : '/my-applications');
    if (subject) sessionStorage.setItem('iam.stepup.subject', 'fixture-user');
    const s = {
      api: { completeBrowserLogin: vi.fn(async () => {}) }, signedIn: vi.fn(), say: vi.fn(),
      loadAccess: vi.fn(async () => ({ subject })), refresh: vi.fn(), testBranch: () => null,
    };
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: s }] });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    TestBed.createComponent(CallbackPage);
    await new Promise(r => setTimeout(r, 0));
    expect(s.signedIn).toHaveBeenCalledOnce(); expect(s.refresh).not.toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(subject === 'fixture-user' ? '/users' : '/my-applications', { replaceUrl: true });
    expect(s.loadAccess).toHaveBeenCalledTimes(subject ? 1 : 0);
    expect(sessionStorage.getItem('iam.stepup.subject')).toBeNull();
    expect(sessionStorage.getItem('iam.return')).toBeNull();
  });
});
