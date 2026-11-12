import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Session } from './session';
import { ProfileReviewsPage } from './profile-reviews';

describe('profile review publication effects', () => {
  it('names the actual target in buttons and success, independently of the selected admin branch', async () => {
    const reviews = [{ id: 'alice', subject: 'alice', changes: [] }, { id: 'bob;testing', subject: 'bob', branch: 'testing', changes: [] }];
    const calls: string[] = [];
    TestBed.configureTestingModule({ providers: [{ provide: Session, useValue: {
      branchEpoch: signal(0), adminToken: signal(''), branch: signal('admin-draft'), api: { raw: async (method: string, path: string) => {
        calls.push(path); return { status: 200, data: method === 'GET' ? { reviews, policy: 'review' } : {} };
      } },
    } }] });
    const fixture = TestBed.createComponent(ProfileReviewsPage), page = fixture.componentInstance as any;
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Accept & publish to main');
    expect(text).toContain('Accept & publish to testing');
    expect(text).not.toContain('Accept (merge into main)');
    expect(text).toContain('No separate Review & Apply step');
    await page.decide('bob;testing', true);
    expect(calls).toContain('/profile-reviews/bob%3Btesting/accept');
    expect(page.note()).toContain('published to testing');
    expect(page.note()).not.toContain('are live');
    await page.decide('alice', true);
    expect(page.note()).toContain('published to main');
    await page.decide('alice', false);
    expect(page.note()).toContain('change set was deleted');
    expect(page.note()).not.toContain('published');
  });
});
