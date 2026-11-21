import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ApplicationsPage, formatMapping, parseList, parseMapping, spMetadataFormValues, scopeChecksFromList, scopeListFromChecks } from './applications';

describe('applications form helpers', () => {
  it('round-trips the attribute mapping', () => {
    const m = { sub: 'id', email: 'email', NameID: 'email' };
    expect(parseMapping(formatMapping(m))).toEqual(m);
  });
  it('parses mapping lines, ignoring blanks and trimming', () => {
    expect(parseMapping(' sub = id \n\nname=display_name\n')).toEqual({ sub: 'id', name: 'display_name' });
  });
  it('parses lists by line or comma, without blanks or duplicates', () => {
    expect(parseList('a, b\nb\n\n c ')).toEqual(['a', 'b', 'c']);
    expect(parseList('')).toEqual([]);
  });
});

describe('SP metadata import into the application form', () => {
  it('fills the fields the document carries and keeps the rest', () => {
    const v = spMetadataFormValues({ entity_id: 'https://sp.example/saml', acs_url: null, sp_certificate: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----' }, { entity: '', acs: 'https://kept.example/acs', cert: '' });
    expect(v).toEqual({ entity: 'https://sp.example/saml', acs: 'https://kept.example/acs', cert: '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----' });
  });
});

describe('OIDC scope checkboxes', () => {
  it('round-trips the scope list, keeping the display order', () => {
    expect(scopeListFromChecks(scopeChecksFromList(['roles', 'profile']))).toEqual(['profile', 'roles']);
    expect(scopeListFromChecks(scopeChecksFromList([]))).toEqual([]);
    expect(scopeChecksFromList(['profile', 'email', 'roles', 'offline_access'])).toEqual({ profile: true, email: true, roles: true, offline_access: true });
  });
});

describe('minimum sign-in level in the application edit form', () => {
  const app = { id: 'finance', name: 'Finance', description: '', protocol: 'oidc', enabled: true, redirect_uris: [], entity_id: null, acs_url: null, attribute_mapping: {}, allowed_roles: [], secret_ref: null, launch_url: null, sp_certificate: null, want_signed_requests: false, nameid_format: null, scopes: [], allow_refresh_tokens: false, logo: null };
  function setup(opts: { security: 'ok' | 'denied'; levelPut?: number }) {
    const calls: { method: string; path: string; body?: any }[] = [];
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: {
      branchEpoch: signal(0), adminToken: signal(''), branch: signal('work'), api: { tenant: 't', raw: async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        if (path === '/app-connectors' && method === 'GET') return { status: 200, data: { apps: [app] } };
        if (path === '/security' && method === 'GET') return opts.security === 'ok' ? { status: 200, data: { working: { appLevels: { finance: { minLevel: 5, maxAgeSeconds: 300 } } } } } : { status: 403, data: { message: 'no' } };
        if (path.startsWith('/security/app-level/')) return { status: opts.levelPut ?? 200, data: { message: 'level refused' } };
        return { status: 200, data: {} };
      } },
    } }] });
    const f = TestBed.createComponent(ApplicationsPage); f.detectChanges();
    return { f, page: f.componentInstance as any, calls };
  }
  it('loads the level from the security setting and writes only a changed level, after the application', async () => {
    const { page, calls } = setup({ security: 'ok' }); await page.load();
    page.edit(app); expect(page.level()).toBe(5);
    await page.save();
    expect(calls.some((c) => c.path.startsWith('/security/app-level/'))).toBe(false);   // unchanged: no second write
    page.edit(app); page.level.set(8); calls.length = 0; await page.save();
    const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(order[0]).toBe('PATCH /app-connectors/finance'); expect(order[1]).toBe('PUT /security/app-level/finance');
    expect(calls.find((c) => c.path.startsWith('/security/app-level/'))!.body).toEqual({ level: 8 });
  });
  it('a failed level write keeps the form open, says the application is saved and the level is not', async () => {
    const { page } = setup({ security: 'ok', levelPut: 400 }); await page.load();
    page.edit(app); page.level.set(2); await page.save();
    expect(page.editing()).toBe(true); expect(page.level()).toBe(2);
    expect(page.problem()).toContain('application is saved'); expect(page.problem()).toContain('NOT saved');
  });
  it('without access to the security setting the selector is read-only and no level write happens', async () => {
    const { page, calls } = setup({ security: 'denied' }); await page.load();
    expect(page.levelAvailable()).toBe(false); page.edit(app); page.level.set(9); calls.length = 0; await page.save();
    expect(calls.some((c) => c.method !== 'GET' && c.path.startsWith('/security'))).toBe(false);
  });
  it('deleting an application also clears every level setting stored for its id', async () => {
    const { page, calls } = setup({ security: 'ok' }); await page.load(); calls.length = 0;
    await page.remove(app);
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual(['DELETE /app-connectors/finance', 'DELETE /security/app-level/finance']);
  });
});
