import { TestBed } from '@angular/core/testing';
import { ApiClient, FormModel, PluginAdminClient, formValues, visibleFields } from './api';
import { PluginsAdmin } from './plugins-admin';

const model: FormModel = { groups: [
  { name: 'General', fields: [
    { key: 'maxDepth', type: 'number', label: 'Depth', value: 5, min: 1, max: 12 },
    { key: 'domains', type: 'list', label: 'Domains', value: [] },
    { key: 'apiKey', type: 'secret', label: 'Key', value: '********' },
    { key: 'mode', type: 'select', label: 'Mode', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'extra', type: 'string', label: 'Extra', value: '', visibleIf: { key: 'mode', equals: 'b' } },
  ] },
] };

describe('plugin form helpers', () => {
  it('types values, splits lists and never sends a masked or empty secret', () => {
    const v = formValues(model, { maxDepth: '7', domains: 'a.fr, b.fr ,', apiKey: '********', mode: 'a' });
    expect(v).toEqual({ maxDepth: 7, domains: ['a.fr', 'b.fr'], mode: 'a' });
    expect(formValues(model, { apiKey: 'new' })['apiKey']).toBe('new');
  });
  it('shows a conditional field only when its condition holds', () => {
    const fs = model.groups[0].fields;
    expect(visibleFields(fs, { mode: 'a' }).map((f) => f.key)).not.toContain('extra');
    expect(visibleFields(fs, { mode: 'b' }).map((f) => f.key)).toContain('extra');
  });
});

describe('PluginAdminClient', () => {
  it('reads with the user token only; writes also carry the admin capability header', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ plugins: [] }) } as Response; }) as unknown as typeof fetch;
    const c = new PluginAdminClient(new ApiClient('acme-demo', f));
    c.adminToken = 'admin-secret-token';
    await c.list(); await c.save('org-manager', { maxDepth: 3 }); await c.enable('org-manager', { hooks: ['x'] });
    const h = (i: number) => calls[i].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('/api/tenants/acme-demo/plugins'); expect(h(0)['x-api-admin-token']).toBeUndefined();
    expect(calls[1].url).toBe('/api/tenants/acme-demo/plugins/org-manager/settings'); expect(h(1)['x-api-admin-token']).toBe('admin-secret-token');
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ grants: { hooks: ['x'] } });
  });
  it('refresh() POSTs the manual cache-refresh endpoint with the admin token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ verified: ['auth-password'] }) } as Response; }) as unknown as typeof fetch;
    const c = new PluginAdminClient(new ApiClient('acme-demo', f));
    c.adminToken = 'admin-secret-token';
    await c.refresh();
    expect(calls[0].url).toBe('/api/tenants/acme-demo/plugins/refresh');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['x-api-admin-token']).toBe('admin-secret-token');
  });
});

const settle = async (fx: { detectChanges(): void }) => { for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 5)); fx.detectChanges(); } };

describe('PluginsAdmin component', () => {
  it('builds the settings form from the schema and shows grant prompts for what the plugin asks', async () => {
    const info = (o: object) => ({ id: 'risk-geo', name: 'Geo risk', version: '0.1.0', kinds: ['risk-signal'], base: false, provides: [], enabled: false, installed: true, grants: {}, requests: { install: false, sensitiveHooks: ['risk.score'], uiComponents: true }, ...o });
    const f = (async (url: string) => ({ ok: true, status: 200, json: async () => (url.endsWith('/form') ? model : { plugins: [info({})] }) }) as Response) as unknown as typeof fetch;
    await TestBed.configureTestingModule({ imports: [PluginsAdmin] }).compileComponents();
    const fx = TestBed.createComponent(PluginsAdmin);
    fx.componentRef.setInput('api', new ApiClient('acme-demo', f));
    fx.detectChanges(); await settle(fx);
    const el = fx.nativeElement as HTMLElement;
    expect(el.querySelector('[data-plugin=risk-geo]')?.textContent).toContain('Installed');
    (el.querySelector('[data-plugin=risk-geo] button') as HTMLButtonElement).click();
    await settle(fx);
    const tabs = () => el.querySelectorAll('.drawer .dtabs button');
    (tabs()[1] as HTMLButtonElement).click(); // Settings
    await settle(fx);
    expect(el.querySelector('[data-field=maxDepth] input[type=number]')).toBeTruthy();
    expect(el.querySelector('[data-field=apiKey] input[type=password]')).toBeTruthy();
    expect(el.querySelector('[data-field=extra]')).toBeNull(); // visibleIf: mode is not b
    (tabs()[2] as HTMLButtonElement).click(); // Lifecycle & permissions
    await settle(fx);
    expect(el.textContent).toContain('risk.score');
    expect(el.textContent).toContain('packaged UI components');
    expect(el.querySelector('#plugin-enable')).toBeTruthy();
  });
});
