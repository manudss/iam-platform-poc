import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiClient } from './api';
import { Session } from './session';
import { SessionTimer, clock } from './session-timer';

const now = () => Math.floor(Date.now() / 1000);
/** A token the way the core issues it: only the payload matters to the console. */
const jwt = (c: Record<string, unknown>) => 'h.' + btoa(JSON.stringify(c)) + '.s';
const claims = (o: Record<string, unknown> = {}) => ({ sub: 'alice', iat: now(), exp: now() + 600, auth_time: now(), session_max: 3600, session_warn: 60, ...o });

function client(opts: { first: string; extend?: () => Response }) {
  const calls: string[] = []; let expired = 0;
  const f = (async (u: string) => {
    calls.push(u);
    if (u === '/core/authorize') return { ok: true, json: async () => ({ code: 'c' }) } as Response;
    if (u === '/core/token') return { ok: true, json: async () => ({ id_token: opts.first }) } as Response;
    if (u === '/core/session/extend') return opts.extend!();
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return { api: new ApiClient('acme-demo', f, () => expired++), calls, expired: () => expired };
}
const reply = (status: number, body: object = {}) => ({ ok: status < 400, status, json: async () => body }) as Response;

describe('session timing and renewal (ApiClient)', () => {
  it('reads timing from the token claims', async () => {
    const c = client({ first: jwt(claims()) }); await c.api.login('a', 'b');
    const i = c.api.sessionInfo!;
    expect(i.end - i.start).toBe(600_000); expect(i.warnMs).toBe(60_000); expect(i.limit! - i.start).toBeGreaterThanOrEqual(3_600_000 - 1000);
  });
  it('has no timing without usable claims, and no limit without session_max', async () => {
    const c = client({ first: 'tok' }); await c.api.login('a', 'b'); expect(c.api.sessionInfo).toBeNull();
    const d = client({ first: jwt(claims({ session_max: undefined })) }); await d.api.login('a', 'b'); expect(d.api.sessionInfo!.limit).toBeNull();
  });
  it('extend swaps in the new token and keeps the same sign-in', async () => {
    const fresh = jwt(claims({ exp: now() + 1200 }));
    const c = client({ first: jwt(claims()), extend: () => reply(200, { id_token: fresh }) }); await c.api.login('a', 'b');
    expect(await c.api.extendSession()).toBe('extended');
    expect(c.api.sessionInfo!.end).toBeGreaterThan(Date.now() + 1_100_000); expect(c.api.loggedIn).toBe(true); expect(c.expired()).toBe(0);
  });
  it('maps 409 to limit and 401 to expired; other failures throw and keep the old token', async () => {
    let r = reply(409); const c = client({ first: jwt(claims()), extend: () => r }); await c.api.login('a', 'b');
    expect(await c.api.extendSession()).toBe('limit'); r = reply(401); expect(await c.api.extendSession()).toBe('expired');
    r = reply(500); await expect(c.api.extendSession()).rejects.toThrow('renewal failed'); expect(c.api.loggedIn).toBe(true);
  });
  it('a renewal that lands after sign-out is dropped', async () => {
    let release!: () => void; const gate = new Promise<void>((x) => (release = x));
    const f = (async (u: string) => {
      if (u === '/core/authorize') return { ok: true, json: async () => ({ code: 'c' }) } as Response;
      if (u === '/core/token') return { ok: true, json: async () => ({ id_token: jwt(claims()) }) } as Response;
      await gate; return reply(200, { id_token: jwt(claims({ exp: now() + 1200 })) });
    }) as typeof fetch;
    const api = new ApiClient('acme-demo', f); await api.login('a', 'b');
    const p = api.extendSession(); api.logout(); release();
    expect(await p).toBe('expired'); expect(api.loggedIn).toBe(false);
  });
  it('a request answered 401 with the OLD token while a renewal happened does not sign the person out', async () => {
    let release!: () => void; const gate = new Promise<void>((x) => (release = x));
    const fresh = jwt(claims({ exp: now() + 1200 }));
    const f = (async (u: string) => {
      if (u === '/core/authorize') return { ok: true, json: async () => ({ code: 'c' }) } as Response;
      if (u === '/core/token') return { ok: true, json: async () => ({ id_token: jwt(claims()) }) } as Response;
      if (u === '/core/session/extend') return reply(200, { id_token: fresh });
      await gate; return reply(401, { message: 'x' });
    }) as typeof fetch;
    let expired = 0; const api = new ApiClient('acme-demo', f, () => expired++); await api.login('a', 'b');
    const slow = api.raw('GET', '/users'); await api.extendSession(); release();
    await expect(slow).rejects.toThrow('just renewed'); expect(api.loggedIn).toBe(true); expect(expired).toBe(0);
  });
});

describe('clock()', () => {
  it('formats m:ss and h:mm:ss', () => { expect(clock(65_000)).toBe('1:05'); expect(clock(0)).toBe('0:00'); expect(clock(3_725_000)).toBe('1:02:05'); });
});

describe('Session timer state', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));
  const signedIn = async (c: Record<string, unknown>, ext?: () => Response) => {
    const k = client({ first: jwt(c), extend: ext }); await k.api.login('a', 'b');
    const s = TestBed.inject(Session); (s as unknown as { api: ApiClient }).api = k.api; s.signedIn('a'); return s;
  };
  it('warns only inside the warning window and can be dismissed when it cannot be extended', async () => {
    const s = await signedIn(claims({ exp: now() + 600 })); expect(s.warning()).toBe(false); expect(s.canExtend()).toBe(true);
    s.signOut();
    const t = await signedIn(claims({ iat: now() - 570, exp: now() + 30, session_max: 30 }));
    expect(t.warning()).toBe(true); expect(t.canExtend()).toBe(false); t.dismissed.set(true); expect(t.warning()).toBe(false); t.signOut();
  });
  it('the bar share goes down with the time left', async () => {
    const s = await signedIn(claims({ iat: now() - 300, exp: now() + 300 })); s.now.set(Date.now());
    expect(s.remainingShare()).toBeGreaterThan(0.45); expect(s.remainingShare()).toBeLessThan(0.55); s.signOut();
  });
  it('extend() renews, clears the warning and reports the limit', async () => {
    let r = reply(200, { id_token: jwt(claims({ exp: now() + 600 })) });
    const s = await signedIn(claims({ iat: now() - 570, exp: now() + 30 }), () => r);
    expect(s.warning()).toBe(true); expect(await s.extend()).toBe(''); expect(s.warning()).toBe(false);
    r = reply(409); expect(await s.extend()).toContain('maximum session length'); s.signOut();
  });
  it('renders the progress bar and the dialog with the Stay signed in button', async () => {
    const s = await signedIn(claims({ iat: now() - 570, exp: now() + 30 }), () => reply(200, { id_token: jwt(claims({ exp: now() + 600 })) }));
    const f = TestBed.createComponent(SessionTimer); f.detectChanges(); const el: HTMLElement = f.nativeElement;
    expect(el.querySelector('#session-timer')).toBeTruthy(); expect(el.querySelector('#session-fill')).toBeTruthy();
    expect(el.querySelector('#session-dialog')).toBeTruthy();
    (el.querySelector('#session-extend') as HTMLButtonElement).click(); await f.whenStable(); f.detectChanges();
    expect(el.querySelector('#session-dialog')).toBeNull(); s.signOut();
  });
});
