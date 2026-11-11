import { describe, it, expect } from 'vitest';
import { canOpen, firstAllowedPath, screenOf, type Access } from './access';

const acc = (screens: string[]): Access => ({ subject: 'x', admin: screens.some((s) => s !== 'my-profile'), restricted: true, plugins: {}, screens, screenAccess: true });

describe('screen access in the console', () => {
  it('maps console URLs to screens', () => {
    expect(screenOf('/users')).toBe('users'); expect(screenOf('/database/pulls?x=1')).toBe('dolt-pulls'); expect(screenOf('/assignments/matrix')).toBe('assignments'); expect(screenOf('/nowhere')).toBeUndefined();
  });
  it('a manager opens people screens only; a main-merger opens the branch screens only; Bob only his profile', () => {
    const lucie = acc(['users', 'profile-reviews', 'assignments', 'my-profile']), noemie = acc(['dolt-pulls', 'dolt-compare', 'dolt-history', 'dolt-branches', 'my-profile']), bob = acc(['my-profile']);
    expect(canOpen(lucie, 'assignments')).toBe(true); expect(canOpen(lucie, 'policies')).toBe(false); expect(canOpen(lucie, 'dolt-sql')).toBe(false);
    expect(canOpen(noemie, 'dolt-branches')).toBe(true); expect(canOpen(noemie, 'users')).toBe(false); expect(canOpen(noemie, 'dolt-data')).toBe(false);
    expect(canOpen(bob, 'my-profile')).toBe(true); expect(canOpen(bob, 'users')).toBe(false);
    expect(firstAllowedPath(lucie)).toBe('/my-applications'); expect(firstAllowedPath(noemie)).toBe('/my-applications'); expect(firstAllowedPath(bob)).toBe('/my-applications'); // the launchpad is every signed-in person's landing
  });
  it('without screen access the legacy rule applies', () => {
    expect(canOpen({ subject: 'x', admin: false, restricted: true, plugins: {} }, 'users')).toBe(false);
    expect(canOpen({ subject: 'x', admin: true, restricted: true, plugins: {} }, 'users')).toBe(true);
  });
});
