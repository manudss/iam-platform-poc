import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Session } from './session';
import { UserAvatar, UserPictures, initialsOf } from './user-avatar';

const PIC = 'data:image/png;base64,AAAA';
function setup(reply: () => Promise<unknown>, branch = 'personal/x') {
  const calls: string[] = [];
  TestBed.configureTestingModule({ providers: [{ provide: Session, useValue: { branch: signal(branch), adminToken: () => '', api: { raw: async (m: string, p: string) => { calls.push(m + ' ' + p); return reply(); } } } }] });
  return { calls, pics: TestBed.inject(UserPictures) };
}
describe('shared user pictures', () => {
  it('loads once per branch and exposes only data images', async () => {
    const { calls, pics } = setup(async () => ({ status: 200, data: { pictures: { a: PIC, b: 'https://evil.example/x.png' } } }));
    await pics.ensure(); await pics.ensure();
    expect(calls).toEqual(['GET /users-pictures']);
    expect(pics.get('a')).toBe(PIC); expect(pics.get('b')).toBe(''); expect(pics.get('c')).toBe('');
  });
  it('a refused or failing request keeps the initials', async () => {
    const r1 = setup(async () => ({ status: 403, data: { message: 'no' } })); await r1.pics.ensure(true); expect(r1.pics.map()).toEqual({});
    TestBed.resetTestingModule();
    const r2 = setup(async () => { throw new Error('boom'); }); await r2.pics.ensure(true); expect(r2.pics.map()).toEqual({});
  });
  it('the avatar shows the picture when present and initials otherwise', async () => {
    setup(async () => ({ status: 200, data: { pictures: { 'demo-alice': PIC } } }));
    await TestBed.inject(UserPictures).ensure(true);
    const withPic = TestBed.createComponent(UserAvatar); withPic.componentRef.setInput('userId', 'demo-alice'); withPic.componentRef.setInput('name', 'Alice Demo'); withPic.detectChanges();
    expect(withPic.nativeElement.querySelector('img')?.getAttribute('src')).toBe(PIC);
    const noPic = TestBed.createComponent(UserAvatar); noPic.componentRef.setInput('userId', 'demo-bob'); noPic.componentRef.setInput('name', 'Bob Demo'); noPic.detectChanges();
    expect(noPic.nativeElement.querySelector('img')).toBeNull(); expect(noPic.nativeElement.textContent.trim()).toBe('BD');
    expect(initialsOf('')).toBe('?');
  });
});
