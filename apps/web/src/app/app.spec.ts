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
