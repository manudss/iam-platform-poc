import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FloatingAssistant } from './floating-assistant';
import { Session } from './session';
import { PluginScreenLoader } from './plugin-screen';

describe('Floating assistant', () => {
  async function setup(enabled = true) {
    localStorage.removeItem('iam-chat-positions');
    let mounts = 0;
    if (!customElements.get('test-floating-chat')) customElements.define('test-floating-chat', class extends HTMLElement {});
    await TestBed.configureTestingModule({ imports: [FloatingAssistant], providers: [provideRouter([]), { provide: PluginScreenLoader, useValue: { load: async () => { mounts++; return { default: 'test-floating-chat' }; } } }] }).compileComponents();
    const s = TestBed.inject(Session);
    s.loggedIn.set(true); s.access.set({ subject: 'demo', admin: true, restricted: true, plugins: {} }); s.selectBranch('b1');
    s.api.raw = (async () => ({ status: 200, data: { screens: enabled ? [{ plugin: 'ai-assistant', id: 'chat', render: 'component', component: 'screens/chat.mjs' }] : [] } })) as never;
    const f = TestBed.createComponent(FloatingAssistant);
    const settle = async () => { f.detectChanges(); await new Promise(r => setTimeout(r, 0)); f.detectChanges(); };
    await settle(); return { s, f, settle, mounts: () => mounts };
  }
  it('fails closed without enabled screen', async () => { const { f } = await setup(false); expect(f.nativeElement.querySelector('#ai-launcher')).toBeNull(); });
  it('hides the launcher when the mcp screen right is missing', async () => { const {s,f,settle}=await setup(); s.access.set({subject:'demo',admin:true,restricted:true,plugins:{},screenAccess:true,screens:['users']}); await settle(); expect(f.nativeElement.querySelector('#ai-launcher')).toBeNull(); });
  it('minimizes without destroying conversation or losing input', async () => {
    const { f, settle, mounts } = await setup(); f.componentInstance.toggle(); await settle();
    const el = f.nativeElement.querySelector('test-floating-chat'); expect(el).toBeTruthy();
    el.innerHTML = '<textarea>Unsent draft</textarea>';
    f.componentInstance.minimize(); await settle(); expect(f.nativeElement.querySelector('test-floating-chat')).toBe(el);
    f.componentInstance.toggle(); await settle(); expect(f.nativeElement.querySelector('textarea').value).toBe('Unsent draft'); expect(mounts()).toBe(1);
  });
  it('resets on branch, disable and sign-out, never carrying context to next session', async () => {
    const { s, f, settle } = await setup(); f.componentInstance.toggle(); await settle();
    expect((f.nativeElement.querySelector('test-floating-chat') as any).context.branch).toBe('b1');
    s.selectBranch('b2'); await settle(); expect(f.nativeElement.querySelector('test-floating-chat')).toBeNull(); expect(f.componentInstance.opened()).toBe(false);
    f.componentInstance.toggle(); await settle(); expect((f.nativeElement.querySelector('test-floating-chat') as any).context.branch).toBe('b2');
    s.api.raw = (async () => ({ status: 200, data: { screens: [] } })) as never; s.pluginsVersion.update(x => x + 1); await settle(); expect(f.nativeElement.querySelector('#ai-launcher')).toBeNull();
    s.loggedIn.set(false); await settle(); expect(f.nativeElement.querySelector('test-floating-chat')).toBeNull();
  });
  it('keeps both controls in the viewport after resize and supports keyboard movement', async () => {
    const { f } = await setup(); const c = f.componentInstance;
    c.launcher = { x: 99999, y: -100 }; c.panel = { x: -1, y: 99999 }; c.resize();
    expect(c.launcher.y).toBe(8); expect(c.launcher.x).toBeLessThan(innerWidth); expect(c.panel.x).toBe(8); expect(c.panel.y).toBeLessThan(innerHeight);
    c.key(new KeyboardEvent('keydown', { key: 'ArrowRight' }), 'panel'); expect(c.panel.x).toBeGreaterThan(8);
  });
});
