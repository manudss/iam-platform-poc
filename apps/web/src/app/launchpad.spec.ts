import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LaunchpadPage, moveApplication, orderedApps, type LaunchpadApp } from './launchpad';
import { Session } from './session';

const APPS = [
  { id: 'peoplehub', name: 'PeopleHub', description: 'HR portal (fictional).', protocol: 'oidc', url: 'https://peoplehub.apps.dss.name/' },
  { id: 'expenseflow', name: 'ExpenseFlow', description: 'Expenses (fictional).', protocol: 'saml', url: 'http://localhost:3000/sso/acme-demo/saml/login?app=expenseflow' },
];

describe('launchpad (the signed-in home)', () => {
  beforeEach(async () => { sessionStorage.clear(); await TestBed.configureTestingModule({ providers: [provideRouter([])] }).compileComponents(); });
  const as = (data: object) => { const s = TestBed.inject(Session); s.loggedIn.set(true); s.user.set('demo-alice'); s.api.raw = (async () => ({ status: 200, data })) as never; return s; };

  it('lists the permitted application links without SSO helper text', async () => {
    as({ apps: APPS });
    const f = TestBed.createComponent(LaunchpadPage); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    const cards = [...el.querySelectorAll('.lp-card')]; expect(cards.length).toBe(2);
    expect(el.querySelector('[data-app="peoplehub"] a')?.getAttribute('href')).toBe(APPS[0].url);
    expect(el.querySelector('[data-app="expenseflow"] a')?.getAttribute('href')).toBe(APPS[1].url);
    expect(el.textContent).not.toContain('Open with SSO');
    expect(el.querySelectorAll('.lp-star').length).toBe(2);
  });
  it('organisation disables launch links and Cancel restores favourite edits', async () => {
    as({ apps: APPS, preferences: { favourites: [], order: [] } });
    const f = TestBed.createComponent(LaunchpadPage); f.detectChanges(); await f.whenStable(); f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('#lp-organise')!.click(); f.detectChanges();
    expect(el.querySelectorAll('.lp-launch').length).toBe(0);
    expect(el.querySelectorAll('.lp-move button').length).toBe(6);
    el.querySelector<HTMLButtonElement>('[data-app="peoplehub"] .lp-star')!.click(); f.detectChanges();
    expect(el.querySelector('[aria-label="Favourites"] [data-app="peoplehub"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('#lp-cancel')!.click(); f.detectChanges();
    expect(el.querySelector('[aria-label="Favourites"] [data-app="peoplehub"]')).toBeNull();
    expect(el.querySelectorAll('.lp-launch').length).toBe(2);
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

const app = (id: string,name=id): LaunchpadApp => ({ id,name,description:'',url:'https://example.invalid',protocol:'oidc' });
describe('gallery ordering', () => {
  it('puts saved IDs first, drops removed IDs, and sorts new apps by name', () => {
    expect(orderedApps([app('c'),app('a'),app('b')],['gone','b']).map(a=>a.id)).toEqual(['b','a','c']);
  });
  it('moves only the selected section while leaving other cards in relative order', () => {
    expect(moveApplication(['a','b','c','d'],['b','d'],'d','b')).toEqual(['a','d','c','b']);
    expect(moveApplication(['a','b','c'],['a','b'],'a','b')).toEqual(['b','a','c']);
    expect(moveApplication(['a','b'],['a'],'a','b')).toEqual(['a','b']);
  });
});
