import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { pluginsMatcher, routes } from './app.routes';
import { RETURN_KEY, safeReturn } from './auth';
import { Session } from './session';
import { ApiClient, CORE_PUBLIC, REDIRECT } from './api';
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
    expect(url.startsWith(`${CORE_PUBLIC}/authorize?`)).toBe(true);
    expect([q.get('response_type'), q.get('code_challenge_method'), q.get('redirect_uri')]).toEqual(['code', 'S256', REDIRECT]);
    expect(await challengeFor(s.getItem('iam.pkce.verifier')!)).toBe(q.get('code_challenge'));
    expect(s.getItem('iam.pkce.state')).toBe(q.get('state'));
    expect(url).not.toContain('password');
  });
  it('carries the branch-test parameters to the core when a test link is used', async () => {
    const s = store(); let url = '';
    await new ApiClient().startBrowserLogin(s, (u) => (url = u), undefined, { branch: 'feature-x', ticket: 'ticket-1234567890' });
    const q = new URL(url).searchParams;
    expect(q.get('branch')).toBe('feature-x');
    expect(q.get('ticket')).toBe('ticket-1234567890');
    let plain = '';
    await new ApiClient().startBrowserLogin(store(), (u) => (plain = u));
    expect(new URL(plain).searchParams.get('branch')).toBeNull();
  });
  it('loads the sign-in options of a tested branch with its ticket', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ mode: 'legacy', chains: [] }) } as Response; }) as unknown as typeof fetch;
    await new ApiClient('acme-demo', f).signinOptions({ branch: 'feature-x', ticket: 'ticket-1234567890' });
    expect(seen[0]).toBe('/api/tenants/acme-demo/signin/options?branch=feature-x&ticket=ticket-1234567890');
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

describe('personal space and plugin visibility', () => {
  beforeEach(async () => { sessionStorage.clear(); await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents(); });
  const as = (access: object) => { const s = TestBed.inject(Session); s.loggedIn.set(true); s.user.set('x'); s.api.raw = (async (_m: string, path: string) => ({ status: 200, data: path === '/me/access' ? access : { fields: [], values: {}, sections: {} } })) as never; return s; };
  it('an ordinary account sees only its own profile: no administration menu, admin URLs lead back to My profile', async () => {
    as({ subject: 'demo-bob', admin: false, restricted: true, plugins: { organizations: true } });
    const h = await RouterTestingHarness.create(); await h.navigateByUrl('/roles'); await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    expect(TestBed.inject(Router).url).toBe('/my-profile');
    const el = h.routeNativeElement as HTMLElement;
    expect([...el.querySelectorAll('nav a')].map((a) => a.getAttribute('data-nav'))).toEqual(['/my-profile']);
    expect(el.textContent).not.toContain('Working data branch'); expect(el.textContent).not.toContain('Admin capability');
  });
  it('a plugin that is not enabled has no menu entry and no page', async () => {
    as({ subject: 'demo-alice', admin: true, restricted: true, plugins: {} });
    const h = await RouterTestingHarness.create(); await h.navigateByUrl('/organizations'); await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    expect(TestBed.inject(Router).url).toBe('/overview');
    expect([...(h.routeNativeElement as HTMLElement).querySelectorAll('nav a')].map((a) => a.getAttribute('data-nav'))).not.toContain('/organizations');
  });
});

describe('chosen chain', () => {
  it('is carried to the authorize URL only when it is a plain id', async () => {
    const s = { setItem: () => {} }; let url = '';
    await new ApiClient().startBrowserLogin(s, (u) => (url = u), 'pw-totp');
    expect(new URL(url).searchParams.get('chain')).toBe('pw-totp');
    await new ApiClient().startBrowserLogin(s, (u) => (url = u), 'x&evil=1');
    expect(new URL(url).searchParams.get('chain')).toBeNull();
    expect(url).not.toContain('evil');
  });
});

describe('safeReturn', () => {
  it('only accepts local app paths and never loops back to sign-in', () => {
    expect(safeReturn('/database/pulls')).toBe('/database/pulls');
    expect(safeReturn('//evil.example/x')).toBe('/overview');
    expect(safeReturn('https://evil.example')).toBe('/overview');
    expect(safeReturn('/login')).toBe('/overview'); expect(safeReturn('/callback?code=1')).toBe('/overview');
    expect(safeReturn(null)).toBe('/overview');
  });
});

describe('plugins route matcher', () => {
  it('matches /plugins and /plugins/:id on one route, nothing else', () => {
    const seg = (...p: string[]) => p.map((path) => ({ path, parameters: {} }) as never);
    expect(pluginsMatcher(seg('plugins'), null as never, null as never)?.posParams).toEqual({});
    expect((pluginsMatcher(seg('plugins', 'risk-geo'), null as never, null as never)?.posParams as Record<string, { path: string }>)['id'].path).toBe('risk-geo');
    expect(pluginsMatcher(seg('plugins', 'a', 'b'), null as never, null as never)).toBeNull();
    expect(pluginsMatcher(seg('database'), null as never, null as never)).toBeNull();
  });
});

describe('routing and sign-in guard', () => {
  beforeEach(async () => { sessionStorage.clear(); await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents(); });

  const OPTIONS = { mode: 'choice', chains: [
    { id: 'pw-only', name: 'Password only', declaredLevel: 3, effectiveLevel: 3, mfa: false, simulated: false, recommended: false, steps: [{ name: 'Password', type: 'password', simulated: false }] },
    { id: 'pw-totp', name: 'Password then authenticator', declaredLevel: 7, effectiveLevel: 7, mfa: true, simulated: false, recommended: true, steps: [{ name: 'Password', type: 'password', simulated: false }, { name: 'Authenticator', type: 'totp', simulated: false }] },
    { id: 'mail', name: 'E-mail code', declaredLevel: 4, effectiveLevel: 4, mfa: false, simulated: true, recommended: false, steps: [{ name: 'E-mail code', type: 'email-otp', simulated: true }] },
  ] };

  it('sends a direct link to sign-in when there is no token, and remembers the page to come back to', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(OPTIONS))) as typeof fetch;
    try {
      const h = await RouterTestingHarness.create();
      await h.navigateByUrl('/database/pulls');
      await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
      expect(TestBed.inject(Router).url).toBe('/login');
      expect(sessionStorage.getItem(RETURN_KEY)).toBe('/database/pulls');
      const el = h.routeNativeElement as HTMLElement;
      expect(el.textContent).toContain('IAM platform POC');
      const buttons = Array.from(el.querySelectorAll('#signin-methods button'));
      expect(buttons.map((b) => b.getAttribute('data-chain'))).toEqual(['pw-only', 'pw-totp', 'mail']);
      expect(el.textContent).toContain('recommended');
      expect(el.textContent).toContain('simulated step (no real e-mail is sent)');
      expect(el.textContent).not.toContain('Legacy JSON login');
      expect([...el.querySelectorAll('input[type=password]')].filter((i) => !i.closest('#signup-embedded'))).toHaveLength(0); // the only password field is the sign-up form's
      expect(el.textContent).not.toContain('Merge into main');
    } finally { globalThis.fetch = real; }
  });

  it('falls back to one plain Sign in button when the live configuration has no enabled chain', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ mode: 'legacy', chains: [] }))) as typeof fetch;
    try {
      const h = await RouterTestingHarness.create();
      await h.navigateByUrl('/database/pulls');
      await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
      expect((h.routeNativeElement as HTMLElement).querySelector('#signin-browser')).toBeTruthy();
    } finally { globalThis.fetch = real; }
  });

  it('once signed in, shows the administration layout with the whole navigation and the requested page', async () => {
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.user.set('demo-alice');
    s.api.raw = (async (_m: string, path: string) => ({ status: 200, data: path === '/me/access' ? { subject: 'demo-alice', admin: true, restricted: true, plugins: { organizations: true } } : [] })) as never;    s.workflowsEnabled.set(true); // plugin gate: the Automation menu only exists while the workflows-iga plugin is enabled
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/activation');
    const el = h.routeNativeElement as HTMLElement;
    const nav = [...el.querySelectorAll('nav a')].map((a) => a.getAttribute('data-nav'));
    expect(nav).toEqual(['/overview', '/users', '/profile-fields', '/organizations', '/roles', '/profile-reviews', '/my-profile', '/auth-methods', '/assignments', '/activation', '/workflows', '/plugins', '/event-bus', '/mcp', '/database/branches', '/database/history', '/database/compare', '/database/data', '/database/sql', '/database/pulls']);    expect(el.querySelector('nav a.active')?.getAttribute('data-nav')).toBe('/activation');
    expect(el.querySelector('.who')?.textContent).toContain('demo-alice');
    expect(el.textContent).toContain('Choose your working branch');
  });

  it('workflows-iga plugin disabled: the Workflows menu entry is hidden and its routes fall back to /plugins', async () => {
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.user.set('demo-alice');
    s.api.raw = (async (m: string, path: string) => path === '/plugins'
      ? { status: 200, data: { plugins: [{ id: 'workflows-iga', enabled: false }] } }
      : { status: 200, data: [] }) as never;
    s.workflowsEnabled.set(false);
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/overview');
    const el = h.routeNativeElement as HTMLElement;
    const nav = [...el.querySelectorAll('nav a')].map((a) => a.getAttribute('data-nav'));
    expect(nav).not.toContain('/workflows');
    await h.navigateByUrl('/workflows');
    expect(TestBed.inject(Router).url).toBe('/plugins');
  });

  it('unknown address falls back to the dashboard (through sign-in when needed)', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/nope/nothing');
    expect(TestBed.inject(Router).url).toBe('/login');
  });
});


describe('session expiry handling', () => {
  it('clears a 401 token, signals once, and never retries a mutation; a 403 does not sign out', async () => {
    let status = 200, count = 0, expired = 0;
    const f = (async (u: string) => {
      if (u === '/core/authorize') return { ok: true, json: async () => ({ code: 'c' }) } as Response;
      if (u === '/core/token') return { ok: true, json: async () => ({ id_token: 'tok' }) } as Response;
      count++; return { ok: false, status, json: async () => ({ message: 'denied' }) } as Response;
    }) as typeof fetch;
    const api = new ApiClient('acme-demo', f, () => expired++);
    await api.login('demo-alice', 'x'); status = 403;
    await expect(api.raw('POST', '/plugins/org-manager/install')).rejects.toThrow('denied');
    expect(api.loggedIn).toBe(true); expect(expired).toBe(0);
    status = 401;
    await expect(api.raw('POST', '/plugins/org-manager/install')).rejects.toThrow('Sign in again');
    expect(count).toBe(2); expect(api.loggedIn).toBe(false); expect(expired).toBe(1);
  });
  it('blocks an already expired token before sending an installation', async () => {
    let calls = 0, expired = 0;
    const token = 'a.' + btoa(JSON.stringify({ exp: 1 })) + '.c';
    const f = (async (u: string) => {
      if (u === '/core/authorize') return { ok: true, json: async () => ({ code: 'c' }) } as Response;
      if (u === '/core/token') return { ok: true, json: async () => ({ id_token: token }) } as Response;
      calls++; return {} as Response;
    }) as typeof fetch;
    const api = new ApiClient('acme-demo', f, () => expired++); await api.login('a', 'b');
    await expect(api.raw('POST', '/plugins/org-manager/install')).rejects.toThrow('not retried');
    expect(calls).toBe(0); expect(expired).toBe(1);
  });
  it('returns to login, retains only the page, clears privileged state and ignores duplicate expiry', async () => {
    sessionStorage.clear(); await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    const s = TestBed.inject(Session); s.loggedIn.set(true); s.user.set('alice'); s.adminToken.set('local-test'); s.api.raw = (async () => ({ status: 200, data: { subject: 'alice', admin: true, restricted: true, plugins: {} } })) as never; s.api.activations = async () => []; s.api.assignments = async () => [];
    const h = await RouterTestingHarness.create(); await h.navigateByUrl('/activation');
    s.expire(); await TestBed.inject(Router).navigateByUrl('/login');
    expect(sessionStorage.getItem(RETURN_KEY)).toBe('/activation'); expect(s.adminToken()).toBe('');
    expect(s.loggedIn()).toBe(false); expect(s.expired()).toBe(true);
    s.expire(); expect(sessionStorage.getItem(RETURN_KEY)).toBe('/activation');
  });
});
