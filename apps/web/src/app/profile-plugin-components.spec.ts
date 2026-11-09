import 'poc-plugins/auth-totp/screens/profile.mjs';
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
