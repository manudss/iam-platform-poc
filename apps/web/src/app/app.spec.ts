import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { ApiClient } from './api';
import { challengeFor } from './pkce';

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B S256 test vector', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('ApiClient (fetch is a fake here: no real core/API in this test)', () => {
  it('logs in with code+PKCE and sends the bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = (o: unknown, status = 200) => ({ ok: status < 400, status, json: async () => o }) as Response;
      if (url === '/core/authorize') return body({ code: 'c1' });
      if (url === '/core/token') return body({ id_token: 'tok' });
      return body([{ identity_id: 'demo-bob', role_id: 'payment-creator' }]);
    }) as unknown as typeof fetch;
    const c = new ApiClient('acme-demo', f);
    await c.login('demo-alice', 'x');
    expect(JSON.parse(calls[0].init.body as string).code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(calls[1].init.body as string).code_verifier.length).toBeGreaterThan(42);
    expect(c.loggedIn).toBe(true);
    expect((await c.assignments())[0].role_id).toBe('payment-creator');
    expect((calls[2].init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(calls[2].url).toBe('/api/tenants/acme-demo/assignments');
  });
  it('treats 409 on merge as a SoD refusal, other errors throw', async () => {
    const f = (async () => ({ ok: false, status: 409, json: async () => ({ violations: [{}] }) }) as Response) as unknown as typeof fetch;
    const r = await new ApiClient('t', f).merge('change-aaaaaaaa');
    expect(r.status).toBe(409);
    const g = (async () => ({ ok: false, status: 403, json: async () => ({ message: 'wrong tenant' }) }) as Response) as unknown as typeof fetch;
    await expect(new ApiClient('t', g).assignments()).rejects.toThrow('wrong tenant');
  });
});

describe('browser sign-in flow (client side)', () => {
  const store = () => { const m = new Map<string, string>(); return { setItem: (k: string, v: string) => void m.set(k, v), getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) }; };
  it('leaves for the core with S256, a state and the registered redirect, and keeps the verifier locally', async () => {
    const s = store(); let url = '';
    await new ApiClient().startBrowserLogin(s, (u) => (url = u));
    const q = new URL(url).searchParams;
    expect(url.startsWith('http://127.0.0.1:8081/authorize?')).toBe(true);
    expect([q.get('response_type'), q.get('code_challenge_method'), q.get('redirect_uri')]).toEqual(['code', 'S256', 'http://localhost:4200/callback']);
    expect(await challengeFor(s.getItem('iam.pkce.verifier')!)).toBe(q.get('code_challenge'));
    expect(s.getItem('iam.pkce.state')).toBe(q.get('state'));
    expect(url).not.toContain('password');
  });
  it('callback: matching state exchanges the code with the verifier; a different state is refused without any request', async () => {
    const s = store(); let url = '';
    const calls: string[] = [];
    const f = (async (u: string, init: RequestInit) => { calls.push(`${u} ${init.body}`); return { ok: true, status: 200, json: async () => ({ id_token: 'tok' }) } as Response; }) as unknown as typeof fetch;
    const c = new ApiClient('acme-demo', f);
    await c.startBrowserLogin(s, (u) => (url = u));
    const state = new URL(url).searchParams.get('state')!;
    await expect(c.completeBrowserLogin(`?code=attacker&state=forged`, s)).rejects.toThrow('state mismatch');
    expect(calls.length).toBe(0); expect(c.loggedIn).toBe(false);
    await c.startBrowserLogin(s, (u) => (url = u));
    const st2 = new URL(url).searchParams.get('state')!; expect(st2).not.toBe(state);
    await c.completeBrowserLogin(`?code=abc&state=${st2}`, s);
    expect(c.loggedIn).toBe(true); expect(calls[0]).toContain('/core/token'); expect(calls[0]).toContain('"code":"abc"');
    await expect(c.completeBrowserLogin(`?code=abc&state=${st2}`, s)).rejects.toThrow('state mismatch'); // single use
  });
});

describe('App', () => {
  beforeEach(async () => { await TestBed.configureTestingModule({ imports: [App] }).compileComponents(); });

  it('renders title and the sign-in form first', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('IAM platform POC');
    expect(el.querySelector('input[type=password]')).toBeTruthy();
    expect(el.textContent).not.toContain('Merge into main');
  });
});
