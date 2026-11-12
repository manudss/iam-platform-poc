import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Session } from './session';
import { ProfileFieldsPage } from './profile-fields';

const catalog = [{ fullKey: 'hr-attributes.phone', plugin: 'hr-attributes', label: 'Phone', type: 'phone', klass: 'profile', storage: 'table', section: 'Contact' }];
const config = { fields: {}, signup: { open: false } };
export const profileResponse = (path: string) => {
  if (path === '/profile-fields') return { catalogue: catalog, working: { config, settings: {} }, live: { config }, inactiveCatalogue: [] };
  if (path.startsWith('/profile-schema')) return { fields: [{ key: 'hr-attributes.phone', label: 'Phone', type: 'phone', editable: true, section: 'Contact' }] };
  if (path === '/profile-components-inventory') return { components: [] };
  if (path === '/auth/enrollment-stats') return { instances: {} };
  if (path === '/signup/requests') return { requests: [] };
  return {};
};
describe('profile configuration saved preview', () => {
  it('labels saved data, warns about unsaved edits and refreshes only after a successful save', async () => {
    let previews = 0, fail = false;
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: {
      branchEpoch: signal(0), adminToken: signal(''), branch: signal('work'), api: { raw: async (method: string, path: string) => {
        if (path.startsWith('/profile-schema')) previews++;
        return method === 'PUT' && fail ? { status: 400, data: { message: 'Refused' } } : { status: 200, data: profileResponse(path) };
      } },
    } }] });
    const fixture = TestBed.createComponent(ProfileFieldsPage), page = fixture.componentInstance as any;
    fixture.detectChanges(); await fixture.whenStable(); await new Promise(resolve => setTimeout(resolve, 0));
    page.tab.set('preview'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#pf-preview h3').textContent).toContain('saved working branch');
    expect(fixture.nativeElement.querySelector('#pf-preview-saved')).not.toBeNull();
    const before = previews;
    page.dirty.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#pf-preview-unsaved').textContent).toContain('Unsaved edits are not shown');
    expect(fixture.nativeElement.querySelector('#pf-preview-saved')).toBeNull();
    expect(previews).toBe(before);
    fail = true; await page.save(); fixture.detectChanges();
    expect(page.dirty()).toBe(true);
    expect(fixture.nativeElement.querySelector('#pf-preview-unsaved')).not.toBeNull();
    fail = false; await page.save(); await fixture.whenStable(); await new Promise(resolve => setTimeout(resolve, 0)); fixture.detectChanges();
    expect(page.dirty()).toBe(false); expect(previews).toBe(before + 3);
    expect(fixture.nativeElement.querySelector('#pf-preview-unsaved')).toBeNull();
    expect(fixture.nativeElement.querySelector('#pf-preview-saved')).not.toBeNull();
  });
});
