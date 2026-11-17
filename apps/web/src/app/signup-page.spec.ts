import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';

/** Public account-request form: visible + field-anchored errors, in-flight state blocking double submits. */
describe('signup page', () => {
  const real = globalThis.fetch;
  afterEach(() => { globalThis.fetch = real; sessionStorage.clear(); });
  function deferred() { let resolve!: (v: Response) => void; const promise = new Promise<Response>((r) => { resolve = r; }); return { promise, resolve }; }
  const SCHEMA = { fields: [
    { key: 'job.title', label: 'Job title', type: 'text', required: false },
    { key: 'prefs.language', label: 'Language', type: 'select', required: false, options: [{ value: 'en', label: 'English' }, { value: 'fr', label: 'Français' }] },
  ] };
  async function page(post?: { promise: Promise<Response> }) {
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      const s = String(u);
      if (s.endsWith('/signup/schema')) return new Response(JSON.stringify(SCHEMA));
      if (init?.method === 'POST' && post) return post.promise;
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/signup');
    await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    return h;
  }
  function fill(el: HTMLElement, name: string, v: string) { const i = el.querySelector(`input[name="${name}"]`) as HTMLInputElement; i.value = v; i.dispatchEvent(new Event('input')); }
  function submit(el: HTMLElement) { el.querySelector('#su-form')!.dispatchEvent(new Event('submit', { cancelable: true })); }

  it('shows a styled error summary anchored to the field, an inline error, and moves focus', async () => {
    const post = deferred();
    const h = await page(post);
    const el = h.routeNativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('Create an account');
    expect(el.textContent).toContain('(optional)'); // Job title and Language stay, clearly optional
    fill(el, 'id', 'ada-example'); fill(el, 'dn', 'Ada Exemple'); fill(el, 'em', 'ada.exemple@example.test'); fill(el, 'pw', 'fictionalpass');
    h.detectChanges();
    submit(el); h.detectChanges();
    // in flight: button and fields locked, progress announced, a second submit is impossible
    const btn = el.querySelector('#su-send') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Creating account');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect((el.querySelector('.su-fields') as HTMLFieldSetElement).disabled).toBe(true);
    submit(el); // ignored while busy: still a single in-flight POST
    post.resolve(new Response(JSON.stringify({ message: ['password: at least one uppercase letter is required', 'id: this id is already taken'] }), { status: 400 }));
    await new Promise((r) => setTimeout(r, 5)); h.detectChanges();
    const banner = el.querySelector('#su-error') as HTMLElement;
    expect(banner?.classList.contains('alert-err')).toBe(true);
    expect(banner.textContent).toContain('Your request could not be sent.');
    expect(banner.textContent).toContain('At least one uppercase letter is required');
    expect(banner.querySelector('a[href="#su-pw"]')).toBeTruthy();
    expect(el.querySelector('#su-pw-err')?.textContent).toContain('At least one uppercase letter is required');
    expect(el.querySelector('#su-id-err')?.textContent).toContain('already taken');
    expect((el.querySelector('#su-pw') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(banner);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Create account');
  });

  it('maps a refusal by rate limit to a clear message', async () => {
    const post = deferred();
    const h = await page(post);
    const el = h.routeNativeElement as HTMLElement;
    fill(el, 'id', 'ada-example'); fill(el, 'dn', 'Ada Exemple'); fill(el, 'em', 'ada.exemple@example.test'); fill(el, 'pw', 'fictionalpass1');
    h.detectChanges(); submit(el); h.detectChanges();
    post.resolve(new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429 }));
    await new Promise((r) => setTimeout(r, 5)); h.detectChanges();
    expect(el.querySelector('#su-error')?.textContent).toContain('Too many requests.');
    expect(document.activeElement).toBe(el.querySelector('#su-error')); // focus moves to the banner on every refusal
  });

  it('locks the confirmation form while the code is being checked', async () => {
    const post = deferred(); const conf = deferred();
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      const s = String(u);
      if (s.endsWith('/signup/schema')) return new Response(JSON.stringify(SCHEMA));
      if (s.endsWith('/signup/confirm')) return conf.promise;
      if (init?.method === 'POST') return post.promise;
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/signup');
    await new Promise((r) => setTimeout(r, 0)); h.detectChanges();
    const el = h.routeNativeElement as HTMLElement;
    fill(el, 'id', 'ada-example'); fill(el, 'dn', 'Ada Exemple'); fill(el, 'em', 'ada.exemple@example.test'); fill(el, 'pw', 'fictionalpass1');
    h.detectChanges(); submit(el);
    post.resolve(new Response(JSON.stringify({ message: 'If the request can be accepted, a confirmation code is on its way.' })));
    await new Promise((r) => setTimeout(r, 5)); h.detectChanges();
    expect(el.querySelector('#su-sent')).toBeTruthy();
    fill(el, 'code', '123456'); h.detectChanges();
    const cform = el.querySelector('#su-confirm')!.closest('form')!;
    cform.dispatchEvent(new Event('submit', { cancelable: true })); h.detectChanges();
    const cbtn = el.querySelector('#su-confirm') as HTMLButtonElement;
    expect(cbtn.disabled).toBe(true);
    expect(cbtn.textContent).toContain('Confirming');
    conf.resolve(new Response(JSON.stringify({ message: 'E-mail confirmed.' })));
    await new Promise((r) => setTimeout(r, 5)); h.detectChanges();
    expect(cbtn.disabled).toBe(false);
    expect(el.textContent).toContain('E-mail confirmed.');
  });
});
