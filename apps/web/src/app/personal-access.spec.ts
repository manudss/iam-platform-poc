import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Shell } from './shell';
import { Session } from './session';
import { authGuard } from './auth';
import { accessGuard } from './access';
import { StepUpPage } from './step-up';

@Component({ template: '<p id="personal-page">Personal page</p>' }) class PersonalPage {}
@Component({ template: '<p id="admin-page">Admin page</p>' }) class AdminPage {}
const adminPaths = (paths: string[]) => paths.filter((p) => /^\/(workspace|versioning|plugins|branding\/draft)/.test(p));

describe('personal and administration boundary', () => {
  async function boot(level = 3, minLevel = 5) {
    await TestBed.configureTestingModule({ providers: [provideRouter([
      { path: 'step-up', component: StepUpPage, canActivate: [authGuard] },
      { path: '', component: Shell, canActivate: [authGuard], children: [
        { path: 'my-applications', component: PersonalPage }, { path: 'my-profile', component: PersonalPage },
        { path: 'users', component: AdminPage, canActivate: [accessGuard] },
      ] },
    ])] }).compileComponents();
    const s = TestBed.inject(Session), calls: string[] = [];
    s.loggedIn.set(true); s.user.set('fixture-admin');
    s.api.raw = (async (_m: string, path: string) => {
      calls.push(path);
      if (path === '/me/access') return { status: 200, data: { subject: 'fixture-admin', admin: true, restricted: true, plugins: {} } };
      if (path === '/auth/me/admin-assurance') return { status: 200, data: level < minLevel ? { ok: false, requiredLevel: minLevel, currentLevel: level } : { ok: true } };
      if (path.startsWith('/auth/me/step-up')) return { status: 200, data: { chains: [{ id: 'mail', name: 'Password and email', declaredLevel: 6, effectiveLevel: 6, simulated: false, steps: [], mfa: true, recommended: false }] } };
      if (path === '/workspace/personal') return { status: 201, data: { branch: 'personal/fixture-admin', status: 'reused' } };
      if (path === '/versioning/branches') return { status: 200, data: { branches: [] } };
      if (path === '/me/profile') return { status: 200, data: { values: {} } };
      if (path === '@/health') return { status: 200, data: {} };
      return { status: 200, data: {} };
    }) as never;
    const h = await RouterTestingHarness.create();
    const settle = async () => { await new Promise((r) => setTimeout(r, 0)); h.detectChanges(); };
    return { s, calls, h, settle, router: TestBed.inject(Router) };
  }
  for (const path of ['/my-applications', '/my-profile']) it(path + ' never initializes administration for a low-level administrator', async () => {
    const { h, calls, settle, s, router } = await boot();
    await h.navigateByUrl(path); await settle();
    expect(h.routeNativeElement?.querySelector('#personal-page')).not.toBeNull();
    expect(adminPaths(calls)).toEqual([]);
    expect(calls).not.toContain('/auth/me/admin-assurance');
    s.api.onStepUp?.({ requiredLevel: 5, currentLevel: 3 }); await settle();
    expect(router.url).toBe(path); // stale admin response after leaving the protected area
    expect(h.routeNativeElement?.querySelector('#branch-picker-button')).toBeNull();
  });
  for (const minLevel of [5, 6]) it('checks the configured threshold ' + minLevel + ' before mounting admin or opening a workspace', async () => {
    const { h, calls, settle, router } = await boot(3, minLevel);
    await h.navigateByUrl('/users'); await settle();
    expect(router.url).toContain('/step-up?'); expect(router.url).toContain('level=' + minLevel);
    expect(adminPaths(calls)).toEqual([]); expect(h.routeNativeElement?.querySelector('#admin-page')).toBeNull();
    expect(h.routeNativeElement?.querySelector('#su-profile')).not.toBeNull();
    expect(h.routeNativeElement?.querySelector('#su-applications')).not.toBeNull();
    (h.routeNativeElement?.querySelector('#su-cancel') as HTMLButtonElement).click(); await settle();
    expect(router.url).toBe('/my-applications'); expect(adminPaths(calls)).toEqual([]);
    await settle(); expect(router.url).toBe('/my-applications');
  });
  it('an accepted assurance check precedes workspace initialization', async () => {
    const { h, calls, settle } = await boot(6, 5);
    await h.navigateByUrl('/users'); await settle();
    expect(h.routeNativeElement?.querySelector('#admin-page')).not.toBeNull();
    expect(calls.indexOf('/auth/me/admin-assurance')).toBeLessThan(calls.indexOf('/workspace/personal'));
    expect(calls).toContain('/workspace/personal');
  });
});
