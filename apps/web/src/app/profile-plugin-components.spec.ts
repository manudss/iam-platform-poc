import 'poc-plugins/auth-totp/screens/profile.mjs';
import 'poc-plugins/auth-sso-google/screens/profile.mjs';
import 'poc-plugins/auth-digit-code/screens/profile.mjs';
import 'poc-plugins/auth-password/screens/profile.mjs';
import 'poc-plugins/profile-picture/screens/picture.mjs';
import { PluginScreenLoader } from './plugin-screen';

/** The packaged profile components run as custom elements with a context handed by the host. These specs mount
 * them directly: no Angular involved, exactly like the host does. fetch is stubbed per test. */
describe('packaged profile components (plugins/*/screens/*.mjs)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; document.body.replaceChildren(); });
  const mount = async (tag: string, context: Record<string, unknown>, fetchImpl: (path: string) => { status: number; data: unknown }) => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      const r = fetchImpl(url);
      return new Response(JSON.stringify(r.data), { status: r.status });
    }) as never;
    const el = document.createElement(tag) as HTMLElement & { context?: unknown };
    el.context = context;
    document.body.appendChild(el); // connectedCallback fires here
    await new Promise((r) => setTimeout(r, 5));
    return el;
  };
  const ctx = (over: Record<string, unknown>) => ({ tenant: 'acme', api: '/api/tenants/acme', token: 't', adminToken: 'a', branch: '', surface: 'self', mode: 'manage', ...over });
  const enrollments = (methods: object[], enrollments: object = {}) => ({ status: 200, data: { methods, enrollments } });
  const TOTP = { id: 'authenticator-app', type: 'totp', name: 'Authenticator app' };
  const PIN = { id: 'pin-keypad', type: 'digit-code', name: 'PIN keypad', config: { length: 6 } };

  it('renders a local QR for a fresh self enrollment and never shows it to an administrator', async () => {
    const el = await mount('iam-totp-profile', ctx({}), (p) => p.endsWith('/totp') ? { status: 200, data: { shownOnce: { secret: 'FICTIONAL', otpauthUri: 'otpauth://totp/Fixture?secret=JBSWY3DPEHPK3PXP&issuer=Fixture' } } } : enrollments([TOTP]));
    el.shadowRoot!.querySelector<HTMLButtonElement>('.enroll')!.click();
    await new Promise(r => setTimeout(r, 20));
    expect(el.shadowRoot!.querySelector('.qr svg')).not.toBeNull();
    expect(el.shadowRoot!.querySelectorAll('img')).toHaveLength(0);
    const admin = await mount('iam-totp-profile', ctx({ surface: 'admin', subject: 'u1' }), () => enrollments([TOTP]));
    expect(admin.shadowRoot!.querySelector('.qr')).toBeNull();
  });

  it('does not turn an unavailable password lock status into an unlocked claim', async () => {
    const el = await mount('iam-password-profile', ctx({ surface: 'admin', subject: 'u1' }), () => enrollments([]));
    expect(el.shadowRoot!.textContent).toContain('Unavailable:');
    expect(el.shadowRoot!.textContent).toContain('not an unlocked status');
    expect(el.shadowRoot!.querySelector('input')).toBeNull();
  });

  it('readonly mode shows the status but no mutating control (TOTP and PIN)', async () => {
    const totp = await mount('iam-totp-profile', ctx({ surface: 'admin', subject: 'u1', mode: 'readonly' }), (p) =>
      p.includes('/auth/enrollments/u1') ? enrollments([TOTP], { 'authenticator-app': { totp: { at: 'x' } } }) : enrollments([]));
    const btns = [...totp.shadowRoot!.querySelectorAll('button')].map((b) => b.textContent!.trim());
    expect(btns).toEqual([]);
    expect(totp.shadowRoot!.textContent).toContain('Enrolled');
    const pin = await mount('iam-pin-profile', ctx({ surface: 'admin', subject: 'u1', mode: 'readonly' }), (p) =>
      p.includes('/auth/enrollments/u1') ? enrollments([PIN], { 'pin-keypad': { pin: { length: 6 } } }) : enrollments([]));
    expect([...pin.shadowRoot!.querySelectorAll('button')]).toEqual([]);
    expect(pin.shadowRoot!.textContent).toContain('Set (6 digits)');
    expect(pin.shadowRoot!.textContent).not.toContain('Set a new PIN');
  });

  it('a method name with markup and quotes is escaped in text and in the data-inst attribute', async () => {
    const evil = { id: 'pin"><img src=x onerror=alert(1)>', type: 'digit-code', name: '<b>PIN</b> "quoted"' };
    const el = await mount('iam-pin-profile', ctx({}), () => enrollments([evil]));
    expect(el.shadowRoot!.querySelector('img')).toBeNull();
    const b = el.shadowRoot!.querySelector('.row b')!; // the component's own bold wrapper, not injected markup
    expect(b.children.length).toBe(0);
    expect(b.textContent).toBe('<b>PIN</b> "quoted"');
    const row = el.shadowRoot!.querySelector('.row[data-inst]')!;
    expect(row.getAttribute('data-inst')).toBe(evil.id); // round-trips through the attribute
    expect(row.textContent).toContain('<b>PIN</b> "quoted"'); // shown as text, not markup
  });

  it('an error message from the server is escaped', async () => {
    const el = await mount('iam-pin-profile', ctx({}), () => ({ status: 500, data: { message: '<img src=x onerror=alert(2)> boom' } }));
    expect(el.shadowRoot!.querySelector('img')).toBeNull();
    expect(el.shadowRoot!.textContent).toContain('<img src=x onerror=alert(2)> boom');
  });

  it('admin PIN edit asks only the new PIN; self with an existing PIN asks the current one', async () => {
    const admin = await mount('iam-pin-profile', ctx({ surface: 'admin', subject: 'u1' }), (p) =>
      p.includes('/auth/enrollments/u1') ? enrollments([PIN], { 'pin-keypad': { pin: { length: 6 } } }) : enrollments([]));
    admin.shadowRoot!.querySelector<HTMLButtonElement>('.change')!.click();
    expect(admin.shadowRoot!.querySelector('.cur')).toBeNull();
    expect(admin.shadowRoot!.querySelector('.pin')).not.toBeNull();
    const self = await mount('iam-pin-profile', ctx({}), () => enrollments([PIN], { 'pin-keypad': { pin: { length: 6 } } }));
    self.shadowRoot!.querySelector<HTMLButtonElement>('.change')!.click();
    expect(self.shadowRoot!.querySelector('.cur')).not.toBeNull();
  });

  it('revocation is a two-step inline confirmation, never a silent immediate call', async () => {
    const calls: string[] = [];
    const el = await mount('iam-totp-profile', ctx({ surface: 'admin', subject: 'u1' }), (p) => {
      calls.push(p);
      return p.includes('/auth/enrollments/u1') ? enrollments([TOTP], { 'authenticator-app': { totp: { at: 'x' } } }) : enrollments([]);
    });
    el.shadowRoot!.querySelector<HTMLButtonElement>('.remove')!.click();
    expect(calls.filter((p) => p.includes('DELETE'))).toEqual([]);
    expect(el.shadowRoot!.textContent).toContain('Really revoke');
    el.shadowRoot!.querySelector<HTMLButtonElement>('.cancel-remove')!.click();
    expect(el.shadowRoot!.textContent).not.toContain('Really revoke');
  });

  it('the admin surface carries the immediate-effect note next to the controls', async () => {
    const el = await mount('iam-totp-profile', ctx({ surface: 'admin', subject: 'u1' }), (p) =>
      p.includes('/auth/enrollments/u1') ? enrollments([TOTP], {}) : enrollments([]));
    expect(el.shadowRoot!.textContent).toContain('take effect immediately');
    const self = await mount('iam-totp-profile', ctx({}), () => enrollments([TOTP], {}));
    expect(self.shadowRoot!.textContent).not.toContain('take effect immediately');
  });

  it('readonly password replaces the form by a note', async () => {
    const el = await mount('iam-password-profile', ctx({ mode: 'readonly' }), () => ({ status: 200, data: {} }));
    expect(el.shadowRoot!.querySelector('button')).toBeNull();
    expect(el.shadowRoot!.textContent).toContain('read only');
  });

  it('the custom elements are registered once (the in-module guard makes a re-import from another URL safe)', () => {
    // Importing this spec already evaluated each module; a second define without the guard would have thrown.
    expect(customElements.get('iam-totp-profile')).toBeTruthy();
    expect(customElements.get('iam-pin-profile')).toBeTruthy();
    expect(customElements.get('iam-password-profile')).toBeTruthy();
    expect(customElements.get('iam-profile-picture')).toBeTruthy();
  });

  const GOOG = { id: 'goog', type: 'sso-google', name: 'Google' };

  it('SSO: linked status, link start, simulated chooser and completion on the self surface', async () => {
    const calls: { method: string; path: string }[] = [];
    let linked: object = {};
    const el = await mount('iam-sso-google-profile', ctx({}), (p) => {
      const method = p.includes('external-links') ? 'POST' : 'GET';
      calls.push({ method, path: p });
      if (p.endsWith('/auth/me/enrollments')) return enrollments([GOOG], linked);
      if (p.endsWith('/external-links/goog/complete')) { linked = { goog: { external: { sub: 'sim-google-ada', email: 'ada@example.invalid', linkedAt: '2026-11-16T00:00:00Z' } } }; return { status: 200, data: { linked: true, simulated: true } }; }
      if (p.endsWith('/external-links/goog')) return { status: 200, data: { mode: 'simulated', title: 'Google (simulated)', state: 'st-1', identities: [{ sub: 'sim-google-ada', label: 'Ada Lovelace (fiction)' }] } };
      return enrollments([]);
    });
    expect(el.shadowRoot!.textContent).toContain('Not linked');
    el.shadowRoot!.querySelector<HTMLButtonElement>('.link')!.click();
    await new Promise(r => setTimeout(r, 20));
    // the DEMO chooser renders in-page, clearly marked; the server was asked with the console return URL
    expect(el.shadowRoot!.textContent).toContain('DEMO: simulated provider');
    expect(el.shadowRoot!.textContent).toContain('Ada Lovelace (fiction)');
    el.shadowRoot!.querySelector<HTMLButtonElement>('.chooser .idbtn')!.click();
    await new Promise(r => setTimeout(r, 20));
    expect(calls.some((c) => c.path.endsWith('/external-links/goog/complete'))).toBe(true);
    expect(el.shadowRoot!.textContent).toContain('Linked (SIMULATED provider');
    expect(el.shadowRoot!.textContent).toContain('Linked');
    expect(el.shadowRoot!.textContent).toContain('ada@example.invalid');
  });

  it('SSO: a real provider answer navigates the browser, never renders a chooser', async () => {
    const assigned: string[] = [];
    const el = await mount('iam-sso-google-profile', ctx({}), (p) => {
      if (p.endsWith('/auth/me/enrollments')) return enrollments([GOOG], {});
      if (p.endsWith('/external-links/goog')) return { status: 200, data: { mode: 'redirect', url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' } };
      return enrollments([]);
    });
    // stub location.assign (jsdom does not navigate)
    const orig = Object.getOwnPropertyDescriptor(window, 'location');
    const fakeLoc = { ...window.location, assign: (u: string) => assigned.push(u), origin: window.location.origin, pathname: window.location.pathname };
    Object.defineProperty(window, 'location', { value: fakeLoc, configurable: true });
    try {
      el.shadowRoot!.querySelector<HTMLButtonElement>('.link')!.click();
      await new Promise(r => setTimeout(r, 20));
      expect(assigned).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client_id=x']);
      expect(el.shadowRoot!.querySelector('.chooser')).toBeNull();
    } finally { if (orig) Object.defineProperty(window, 'location', orig); }
  });

  it('SSO: admin surface shows status and revoke, never a link control', async () => {
    const el = await mount('iam-sso-google-profile', ctx({ surface: 'admin', subject: 'u1' }), (p) =>
      p.includes('/auth/enrollments/u1') ? enrollments([GOOG], { goog: { external: { sub: 'sub-1', email: null, linkedAt: '2026-11-15T00:00:00Z' } } }) : enrollments([]));
    expect(el.shadowRoot!.textContent).toContain('Linked');
    expect(el.shadowRoot!.textContent).toContain('never create one');
    expect(el.shadowRoot!.querySelector('.link')).toBeNull();
    el.shadowRoot!.querySelector<HTMLButtonElement>('.remove')!.click();
    expect(el.shadowRoot!.textContent).toContain('Really revoke this link');
  });

  it('SSO: readonly mode shows the status but no mutating control', async () => {
    const el = await mount('iam-sso-google-profile', ctx({ mode: 'readonly' }), () => enrollments([GOOG], { goog: { external: { sub: 'sub-1', email: null, linkedAt: '2026-11-15T00:00:00Z' } } }));
    expect(el.shadowRoot!.textContent).toContain('Linked');
    expect([...el.shadowRoot!.querySelectorAll('button')]).toEqual([]);
  });

  it('SSO: identity labels and server messages are escaped', async () => {
    const el = await mount('iam-sso-google-profile', ctx({}), (p) => {
      if (p.endsWith('/auth/me/enrollments')) return enrollments([GOOG], {});
      if (p.endsWith('/external-links/goog')) return { status: 200, data: { mode: 'simulated', title: 'G <img src=x onerror=alert(1)>', state: 'st-1', identities: [{ sub: 's1', label: '<b>Evil</b>' }] } };
      return enrollments([]);
    });
    el.shadowRoot!.querySelector<HTMLButtonElement>('.link')!.click();
    await new Promise(r => setTimeout(r, 20));
    expect(el.shadowRoot!.querySelector('.chooser img')).toBeNull();
    expect(el.shadowRoot!.querySelector('.chooser .idbtn')!.innerHTML).not.toContain('<b>Evil</b>');
    expect(el.shadowRoot!.textContent).toContain('<b>Evil</b>');
  });

  it('the password and PIN fields have a show/hide control: hidden by default, only the typed value, focus kept on click, hidden when focus leaves', async () => {
    const pw = await mount('iam-password-profile', ctx({ subject: 'u1' }), () => ({ status: 200, data: {} }));
    const root = pw.shadowRoot!; const cur = root.querySelector('input.cur') as HTMLInputElement; const next = root.querySelector('input.next') as HTMLInputElement;
    expect(cur.type).toBe('password'); expect(next.type).toBe('password');
    const btns = root.querySelectorAll('.reveal-btn'); expect(btns.length).toBe(2);
    const b = btns[1] as HTMLButtonElement; expect(b.getAttribute('type')).toBe('button'); expect(b.getAttribute('aria-pressed')).toBe('false');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true }); b.dispatchEvent(down); expect(down.defaultPrevented).toBe(true);
    b.click(); expect(next.type).toBe('text'); expect(cur.type).toBe('password'); expect(b.getAttribute('aria-pressed')).toBe('true');
    const wrap = next.closest('.reveal-wrap')!;
    wrap.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: b })); expect(next.type).toBe('text');
    wrap.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null })); expect(next.type).toBe('password');
  });
});

describe('PluginScreenLoader cache', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('the same URL is fetched and imported once, however many mounts ask for it', async () => {
    let fetches = 0;
    let imports = 0;
    globalThis.fetch = (async () => { fetches++; return new Response('export default "x"', { status: 200 }); }) as never;
    const loader = new PluginScreenLoader();
    loader.importModule = async () => { imports++; return { default: 'x-tag' }; }; // blob imports are a browser feature
    const [a, b] = await Promise.all([loader.load('/api/t/plugins/p/assets/s.mjs', {}), loader.load('/api/t/plugins/p/assets/s.mjs', {})]);
    expect(fetches).toBe(1);
    expect(imports).toBe(1);
    expect(a).toBe(b);
    await loader.load('/api/t/plugins/p/assets/s.mjs', {});
    expect(fetches).toBe(1);
  });

  it('the cache key includes the branch: the same URL on another branch is fetched again', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response('export default "x"', { status: 200 }); }) as never;
    const loader = new PluginScreenLoader();
    loader.importModule = async () => ({ default: 'x-tag' });
    await loader.load('/api/t/plugins/p/assets/s.mjs', { 'x-iam-branch': 'wip-a' });
    await loader.load('/api/t/plugins/p/assets/s.mjs', { 'x-iam-branch': 'wip-b' });
    expect(fetches).toBe(2);
    await loader.load('/api/t/plugins/p/assets/s.mjs', { 'x-iam-branch': 'wip-a' });
    expect(fetches).toBe(2);
  });

  it('a failed load is not cached: the next attempt retries', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response('nope', { status: 500 }); }) as never;
    const loader = new PluginScreenLoader();
    await expect(loader.load('/api/t/plugins/p/assets/s.mjs', {})).rejects.toThrow('HTTP 500');
    await expect(loader.load('/api/t/plugins/p/assets/s.mjs', {})).rejects.toThrow('HTTP 500');
    expect(fetches).toBe(2);
  });

});
