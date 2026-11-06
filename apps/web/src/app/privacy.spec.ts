import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';

describe('privacy page', () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await TestBed.configureTestingModule({ providers: [provideRouter(routes)] }).compileComponents();
  });

  it('is public: /privacy renders the policy without any sign-in or administration layout', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/privacy');
    await new Promise((r) => setTimeout(r, 0));
    h.detectChanges();
    const el = h.routeNativeElement as HTMLElement;
    expect(TestBed.inject(Router).url).toBe('/privacy');
    expect(el.querySelector('#privacy-page')).toBeTruthy();
    const text = el.textContent ?? '';
    expect(text).toContain('Politique de confidentialité');
    expect(text).toContain('Mailjet');
    expect(text).toContain('Render');
    expect(text).toContain('iam@dss.name');
    expect(text).toContain('Privacy policy'); // English summary is part of the same page
    expect(el.querySelector('nav')).toBeNull(); // no administration layout without a session
  });
});
