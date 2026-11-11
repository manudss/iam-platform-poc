import { REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { LoginPage, isPreview, previewMessage } from './login';

describe('sign-in preview mode', () => {
  it('is off outside a frame, even with ?preview=1', () => {
    history.replaceState({}, '', '/login?preview=1');
    expect(window.parent === window).toBe(true);
    expect(isPreview()).toBe(false);
    history.replaceState({}, '', '/');
  });
  it('accepts only well-formed preview messages', () => {
    expect(previewMessage(null)).toBeNull();
    expect(previewMessage({ type: 'other', chains: [] })).toBeNull();
    expect(previewMessage({ type: 'iam-preview', chains: 'x' })).toBeNull();
    const m = previewMessage({ type: 'iam-preview', chains: [{ id: 'a', name: 'A', steps: [] }, { bad: 1 }], highlight: 'a', view: 'step', step: 2, dark: true });
    expect(m?.chains.length).toBe(1); expect(m?.view).toBe('step'); expect(m?.step).toBe(2); expect(m?.dark).toBe(true);
    expect(previewMessage({ type: 'iam-preview', chains: [], view: 'weird' })?.view).toBe('list');
  });

  it('SSR with a session cookie: ?preview=1 still renders the page instead of bouncing to the console', () => {
    const jwt = `h.${btoa(JSON.stringify({ sub: 'demo-alice', exp: Math.floor(Date.now() / 1000) + 600 }))}.s`;
    const request = new Request('http://localhost/login?preview=1', { headers: { cookie: `iam_session=${jwt}` } });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: REQUEST, useValue: request }] });
    const nav = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const f = TestBed.createComponent(LoginPage);
    f.detectChanges();
    expect(nav).not.toHaveBeenCalled();
  });
});
