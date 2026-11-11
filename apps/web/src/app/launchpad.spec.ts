import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LaunchpadPage } from './launchpad';
import { Session } from './session';

const APPS = [
  { id: 'peoplehub', name: 'PeopleHub', description: 'HR portal (fictional).', protocol: 'oidc', url: 'https://peoplehub.apps.dss.name/' },
  { id: 'expenseflow', name: 'ExpenseFlow', description: 'Expenses (fictional).', protocol: 'saml', url: 'http://localhost:3000/sso/acme-demo/saml/login?app=expenseflow' },
];

describe('launchpad (the signed-in home)', () => {
  beforeEach(async () => { sessionStorage.clear(); await TestBed.configureTestingModule({ providers: [provideRouter([])] }).compileComponents(); });
  const as = (data: object) => { const s = TestBed.inject(Session); s.loggedIn.set(true); s.user.set('demo-alice'); s.api.raw = (async () => ({ status: 200, data })) as never; return s; };

  it('greets the person and lists each application with its protocol badge and SSO link', async () => {
    as({ user: { sub: 'demo-alice', name: 'Alice Demo' }, apps: APPS });
    const f = TestBed.createComponent(LaunchpadPage); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Welcome, Alice Demo');
    const cards = [...el.querySelectorAll<HTMLAnchorElement>('.lp-card')];
    expect(cards.length).toBe(2);
    expect(cards[0].href).toBe('https://peoplehub.apps.dss.name/');
    expect(cards[0].getAttribute('data-app')).toBe('peoplehub');
    expect(cards[0].textContent).toContain('OpenID Connect');
    expect(cards[1].textContent).toContain('SAML 2.0');
    expect(cards[1].href).toContain('/sso/acme-demo/saml/login?app=expenseflow'); // SAML launches IdP-initiated through the IdP
  });

  it('an account with no application sees the empty state, not an error', async () => {
    as({ user: { sub: 'demo-bob', name: 'Bob' }, apps: [] });
    const f = TestBed.createComponent(LaunchpadPage); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('No application is open to your roles yet');
  });

  it('an API failure is shown, without hiding the page', async () => {
    const s = TestBed.inject(Session); s.loggedIn.set(true); s.user.set('demo-alice');
    s.api.raw = (async () => { throw new Error('Refused'); }) as never;
    const f = TestBed.createComponent(LaunchpadPage); f.detectChanges(); await f.whenStable(); f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('Refused');
  });
});
