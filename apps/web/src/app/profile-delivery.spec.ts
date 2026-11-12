import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ProfileFieldsPage } from './profile-fields';

describe('profile configuration confirmation delivery copy', () => {
  it('shows verified live real/simulated states and keeps errors or unverified data unknown', async () => {
    let response: any = { status: 200, data: { mode: 'real', source: 'live' } }, reject = false;
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: {
      branchEpoch: signal(0), adminToken: signal(''), branch: signal('work'), api: { raw: async () => {
        if (reject) throw new Error('offline'); return response;
      } },
    } }] });
    const fixture = TestBed.createComponent(ProfileFieldsPage), page = fixture.componentInstance as any;
    page.tab.set('publish'); fixture.detectChanges();
    for (const [mode, text] of [['real', 'real delivery configured'], ['simulated', 'simulated']]) {
      response = { status: 200, data: { mode, source: 'live' } };
      await page.loadDeliveryStatus(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('#pf-delivery').textContent).toContain(text);
    }
    for (const data of [{ mode: 'real', source: 'work' }, { mode: 'unknown', source: 'live' }, {}]) {
      response = { status: 200, data }; await page.loadDeliveryStatus(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('#pf-delivery').textContent).toContain('unavailable');
      expect(page.deliveryMode()).toBe('unknown');
    }
    reject = true; await page.loadDeliveryStatus(); expect(page.deliveryMode()).toBe('unknown');
    expect(fixture.nativeElement.textContent).not.toContain('simulated here');
  });
});
