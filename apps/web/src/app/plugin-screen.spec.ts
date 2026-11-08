import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { Session } from './session';
import { PluginScreenLoader } from './plugin-screen';

/** Constat 4: the console renders a plugin's packaged screen without any page of its own, and the screen
 * disappears when the plugin leaves the tenant's inventory (disable / grant removed). */
describe('PluginScreenPage (packaged plugin screens)', () => {
  const inventory = (screens: object[]) => {
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.user.set('x'); s.selectBranch('b1');
    s.api.raw = (async (_m: string, path: string) => ({ status: 200, data: path === '/me/access' ? { subject: 'x', admin: true, plugins: {} } : path === '/plugins/screens' ? { screens } : path === '/workspace/personal' ? { branch: 'b1', status: 'reused' } : { entries: [] } })) as never;
    return s;
  };
  const fakeLoader = () => {
    const calls: string[] = [];
    if (!customElements.get('plg-test-orgs')) customElements.define('plg-test-orgs', class extends HTMLElement {
      connectedCallback() { this.innerHTML = '<table id="org-table"><tbody><tr><td>from the plugin package</td></tr></tbody></table>'; }
    });
    return { calls, load: async (url: string) => { calls.push(url); return { default: 'plg-test-orgs' }; } };
  };

  it('imports the plugin module through the assets route and mounts its element with the session context', async () => {
    const loader = fakeLoader();
    await TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: PluginScreenLoader, useValue: loader }] }).compileComponents();
    inventory([{ plugin: 'org-manager', id: 'orgs', title: 'Organizations', area: 'admin', render: 'component', component: 'screens/orgs.mjs' }]);
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/screens/org-manager/orgs');
    await new Promise((r) => setTimeout(r, 10)); h.detectChanges();
    expect(loader.calls).toEqual(['/api/tenants/acme-demo/plugins/org-manager/assets/screens/orgs.mjs']);
    const el = h.routeNativeElement!.querySelector('plg-test-orgs') as HTMLElement & { context?: Record<string, unknown> };
    expect(el.querySelector('#org-table')!.textContent).toContain('from the plugin package');
    expect(el.context).toEqual({ tenant: 'acme-demo', api: '/api/tenants/acme-demo', token: '', adminToken: '', branch: 'b1' });
  });

  it('a screen the inventory no longer lists shows unavailable instead of a page', async () => {
    const loader = fakeLoader();
    await TestBed.configureTestingModule({ providers: [provideRouter(routes), { provide: PluginScreenLoader, useValue: loader }] }).compileComponents();
    inventory([]);
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/screens/org-manager/orgs');
    await new Promise((r) => setTimeout(r, 10)); h.detectChanges();
    expect(loader.calls).toEqual([]);
    expect(h.routeNativeElement!.querySelector('#plugin-screen-problem')!.textContent).toContain('not available');
  });
});
