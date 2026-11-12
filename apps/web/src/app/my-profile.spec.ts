import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Session } from './session';
import { MyProfilePage } from './my-profile';

describe('My profile picture and unsaved edits', () => {
  const PHONE = 'hr-attributes.phone', PHOTO = 'profile-picture.picture';
  let page: any;
  let live: Record<string, unknown>;
  let calls: { method: string; body?: any }[];
  let policy: string;
  beforeEach(() => {
    live = { [PHONE]: 'old phone', [PHOTO]: 'old picture' }; calls = []; policy = 'immediate';
    TestBed.configureTestingModule({ providers: [{ provide: Session, useValue: {
      branchEpoch: signal(0), user: () => 'alice', api: { raw: async (method: string, _path: string, body?: any) => {
        calls.push({ method, body });
        if (method === 'PATCH') { live = { ...live, ...body.values }; return { status: 200, data: {} }; }
        return { status: 200, data: { values: { ...live }, fields: [
          { key: PHONE, type: 'phone', editable: true }, { key: PHOTO, type: 'image', editable: true },
        ], policy, pending: policy === 'review' ? [PHOTO] : [] } };
      } },
    } }] });
    page = TestBed.runInInjectionContext(() => new MyProfilePage()) as any;
  });
  it('keeps an unsaved phone edit when saving a new photo, then submits it normally', async () => {
    await page.load();
    page.set(PHONE, 'my unsaved phone');
    await page.savePicture('new picture');
    expect(page.vals()[PHONE]).toBe('my unsaved phone');
    expect(page.changed).toEqual({ [PHONE]: 'my unsaved phone' });
    expect(page.vals()[PHOTO]).toBe('new picture');
    await page.save();
    expect(live[PHONE]).toBe('my unsaved phone');
    expect(page.changed).toEqual({});
  });
  it('keeps an unsaved cleared value when removing the photo', async () => {
    await page.load(); page.set(PHONE, '');
    await page.savePicture(null);
    expect(page.vals()[PHONE]).toBeNull();
    expect(page.changed[PHONE]).toBeNull();
    expect(page.vals()[PHOTO]).toBeNull();
  });
  it('keeps edits made while the photo request is in flight', async () => {
    await page.load();
    let release!: (r: unknown) => void;
    const api = TestBed.inject(Session).api as any;
    const raw = api.raw;
    api.raw = (method: string, path: string, body?: any) => method === 'PATCH'
      ? new Promise(resolve => { release = async () => resolve(await raw(method, path, body)); }) : raw(method, path, body);
    const saving = page.savePicture('new picture');
    page.set(PHONE, 'typed while waiting'); release({}); await saving;
    expect(page.vals()[PHONE]).toBe('typed while waiting');
    expect(page.changed[PHONE]).toBe('typed while waiting');
  });
  it('does not discard edits or claim a saved photo after a failed upload', async () => {
    await page.load(); page.set(PHONE, 'draft');
    (TestBed.inject(Session).api as any).raw = async () => ({ status: 400, data: { message: 'Invalid picture' } });
    await page.savePicture('invalid');
    expect(page.changed[PHONE]).toBe('draft');
    expect(page.vals()[PHOTO]).toBe('old picture');
    expect(page.problem()).toBe('Invalid picture');
    expect(page.note()).toBe('');
  });
});
