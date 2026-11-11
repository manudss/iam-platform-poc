import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ApiClient } from './api';

/** A structurally valid JWT whose only claim that matters here is exp (seconds). */
const jwt = (exp: number, sub = 'demo-alice') => `h.${btoa(JSON.stringify({ sub, exp })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
const client = () => new ApiClient('t', (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch);

describe('session token persistence (docs/session.md)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());
  it('restores a still-valid token so coming back skips a new sign-in', () => {
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) + 600));
    const c = client();
    expect(c.restore()).toBe(true);
    expect(c.loggedIn).toBe(true);
    expect(c.identity).toBe('demo-alice');
  });
  it('the console itself restores the identity and logout removes the saved session', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) + 600));
    const session = TestBed.inject(Session);
    expect(session.loggedIn()).toBe(true);
    expect(session.user()).toBe('demo-alice');
    session.signOut();
    expect(localStorage.getItem('iam.session')).toBeNull();
    expect(session.api.loggedIn).toBe(false);
  });
  it('drops an expired token instead of restoring it', () => {
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) - 10));
    const c = client();
    expect(c.restore()).toBe(false);
    expect(c.loggedIn).toBe(false);
    expect(localStorage.getItem('iam.session')).toBeNull();
  });
});
