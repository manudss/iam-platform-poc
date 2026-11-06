import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { Theme } from './theme';

describe('color theme', () => {
  beforeEach(() => { localStorage.clear(); delete document.documentElement.dataset['theme']; });

  it('defaults to auto, applies a theme on <html>, and a manual choice is remembered', async () => {
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    const t = TestBed.inject(Theme);
    expect(t.mode()).toBe('auto');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('light'); // jsdom has no dark preference
    t.set('dark');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem('iam.theme')).toBe('dark');
    t.set('light');
    TestBed.tick();
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('iam.theme')).toBe('light');
  });

  it('the sign-in page shows the segmented selector and the footer links (privacy + about)', async () => {
    sessionStorage.clear();
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) =>
      String(u).includes('/signup/schema')
        ? new Response(JSON.stringify({ fields: [] }))
        : new Response(JSON.stringify({ mode: 'legacy', chains: [] }))) as typeof fetch;
    try {
      await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
      const h = await RouterTestingHarness.create();
      await h.navigateByUrl('/login');
      await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
      const el = h.routeNativeElement as HTMLElement;
      expect([...el.querySelectorAll('.seg [data-theme-mode]')].map((b) => b.getAttribute('data-theme-mode'))).toEqual(['auto', 'light', 'dark']);
      expect(el.querySelector('a[href="/about"]')).toBeTruthy();
      expect(el.querySelector('a[href="/privacy"]')).toBeTruthy();
      // sign-up moved to its own page: a link, no embedded form any more
      expect(el.querySelector('a[href="/signup"]')).toBeTruthy();
      expect(el.querySelector('#signup-embedded')).toBeNull();
      expect(el.querySelector('.auth-bg img')).toBeTruthy(); // full-screen random photo with the themed gradient as fallback
    } finally { globalThis.fetch = real; }
  });

  it('the administration top bar carries the same selector', async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    const { Session } = await import('./session');
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.user.set('demo-alice');
    s.api.raw = (async (_m: string, path: string) => ({ status: 200, data: path === '/me/access' ? { subject: 'demo-alice', admin: true, restricted: true, plugins: {} } : [] })) as never;
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/my-profile');
    await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    expect((h.routeNativeElement as HTMLElement).querySelector('.top .seg')).toBeTruthy();
  });
});

describe('about page', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
  });

  it('is public: /about renders the explanations without any sign-in or administration layout', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/about');
    await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    const el = h.routeNativeElement as HTMLElement;
    expect(TestBed.inject(Router).url).toBe('/about');
    expect(el.querySelector('#about-page')).toBeTruthy();
    const text = el.textContent ?? '';
    expect(text).toContain('About this demo');
    expect(text).toContain('Data branches');
    expect(text).toContain('Event bus');
    expect(text).toContain('Plugins');
    expect(el.querySelector('nav')).toBeNull(); // no administration layout without a session
  });

  it('/signup stands on its own page with a way back to sign-in', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ fields: [] }))) as typeof fetch;
    try {
      const h = await RouterTestingHarness.create();
      await h.navigateByUrl('/signup');
      await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
      const el = h.routeNativeElement as HTMLElement;
      expect(el.querySelector('#su-form')).toBeTruthy();
      expect(el.querySelector('a[href="/login"]')).toBeTruthy();
      expect(el.querySelector('.seg')).toBeTruthy();
    } finally { globalThis.fetch = real; }
  });
});
