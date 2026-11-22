import { REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ApiClient, sessionCookieToken } from './api';

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
  it('the console itself restores the identity and logout removes the saved session', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) + 600));
    const session = TestBed.inject(Session);
    await session.restoreSession(); // no edge in this environment: the localStorage copy serves
    expect(session.loggedIn()).toBe(true);
    expect(session.user()).toBe('demo-alice');
    session.signOut();
    expect(localStorage.getItem('iam.session')).toBeNull();
    expect(session.api.loggedIn).toBe(false);
  });

  it('a new sign-in discards cached rights from the previous account', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const s = TestBed.inject(Session);
    let subject = 'first-user';
    const raw = vi.spyOn(s.api, 'raw').mockImplementation(async (_m, path) => ({ status: 200, data: path === '/me/access' ? { subject, admin: true, restricted: true, plugins: {} } : {} }) as never);
    expect((await s.loadAccess()).subject).toBe('first-user');
    subject = 'second-user'; s.signedIn();
    expect(s.access()).toBeNull();
    expect((await s.loadAccess()).subject).toBe('second-user');
    expect(raw.mock.calls.filter(c => c[1] === '/me/access')).toHaveLength(2);
  });

  it('a late previous-account access response cannot restore old rights', async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const s = TestBed.inject(Session);
    let complete!: (value: { status: number; data: unknown }) => void;
    vi.spyOn(s.api, 'raw').mockImplementation(async (_m, path) => path === '/me/access' ? new Promise(r => { complete = r; }) : { status: 200, data: {} } as never);
    const old = s.loadAccess(); s.signedIn();
    complete({ status: 200, data: { subject: 'previous-user', admin: true, restricted: true, plugins: {} } });
    expect((await old).admin).toBe(false); expect(s.access()).toBeNull();
  });

  it('behind the hosted edge the session comes from the cookie bootstrap, never from localStorage', async () => {
    const valid = jwt(Math.floor(Date.now() / 1000) + 600);
    const f = (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ id_token: valid }) })) as unknown as typeof fetch;
    const c = new ApiClient('t', f);
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) - 10)); // a stale copy must not survive
    expect(await c.restoreFromEdge()).toBe('restored');
    expect(c.bearerToken).toBe(valid);
    expect(localStorage.getItem('iam.session')).toBeNull();
    expect(c.loggedIn).toBe(true);
  });

  it('the edge answering without a session clears any stale copy; a non-edge answer falls back to localStorage', async () => {
    const unauthorized = (async () => ({ ok: false, status: 401, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) })) as unknown as typeof fetch;
    const stale = jwt(Math.floor(Date.now() / 1000) + 600);
    localStorage.setItem('iam.session', stale);
    const a = new ApiClient('t', unauthorized);
    expect(await a.restoreFromEdge()).toBe('no-session');
    expect(localStorage.getItem('iam.session')).toBeNull();
    const spaFallback = (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), json: async () => ({}) })) as unknown as typeof fetch;
    const b = new ApiClient('t', spaFallback);
    localStorage.setItem('iam.session', stale);
    expect(await b.restoreFromEdge()).toBe('no-edge');
    expect(b.restore()).toBe(true); // local development keeps the localStorage copy
  });
  it('drops an expired token instead of restoring it', () => {
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) - 10));
    const c = client();
    expect(c.restore()).toBe(false);
    expect(c.loggedIn).toBe(false);
    expect(localStorage.getItem('iam.session')).toBeNull();
  });

  it('server-side render: adopts the session cookie and never touches localStorage', () => {
    const valid = jwt(Math.floor(Date.now() / 1000) + 600);
    const request = new Request('http://localhost/my-applications', { headers: { cookie: `iam_theme=dark; iam_session=${valid}` } });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: REQUEST, useValue: request }] });
    localStorage.setItem('iam.session', jwt(Math.floor(Date.now() / 1000) - 10)); // a stale copy must not be read
    const session = TestBed.inject(Session);
    expect(session.loggedIn()).toBe(true);
    expect(session.user()).toBe('demo-alice');
    expect(session.api.bearerToken).toBe(valid);
  });

  it('sessionCookieToken: only a still-valid iam_session cookie, nothing else', () => {
    const valid = jwt(Math.floor(Date.now() / 1000) + 600);
    expect(sessionCookieToken(`iam_session=${valid}`)).toBe(valid);
    expect(sessionCookieToken(`x=y; iam_session=${valid}; z=w`)).toBe(valid);
    expect(sessionCookieToken(`iam_session=${jwt(Math.floor(Date.now() / 1000) - 10)}`)).toBe('');
    expect(sessionCookieToken('iam_session=not-a-jwt')).toBe('');
    expect(sessionCookieToken('')).toBe('');
    expect(sessionCookieToken('other=1')).toBe('');
  });
});
