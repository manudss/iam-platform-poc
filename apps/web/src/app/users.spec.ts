import { deptColor, filterUsers, initials, managerChain, sortUsers, userStats, userStatus } from './users';
import { UserProfile } from './api';

const u = (id: string, name: string, dept = 'it', manager: string | null = null, enabled = true, cred = true): UserProfile =>
  ({ id, display_name: name, department: dept, email: id + '@example.invalid', manager_id: manager, login_enabled: enabled, hasCredential: cred });

const USERS: UserProfile[] = [
  u('demo-alice', 'Alice Durand', 'it'),
  u('demo-bob', 'Bob Marchand', 'finance'),
  u('camille-martin', 'Camille Martin', 'finance', 'demo-alice'),
  u('ines-roux', 'Inès Roux', 'it', 'camille-martin', true, false), // no credential
  u('tom-garnier', 'Tom Garnier', 'sales', 'camille-martin', false), // disabled
];

describe('users page helpers', () => {
  it('derives the sign-in status from the credential and the flag', () => {
    expect(userStatus(u('a', 'A'))).toBe('enabled');
    expect(userStatus(u('b', 'B', 'it', null, false))).toBe('disabled');
    expect(userStatus(u('c', 'C', 'it', null, true, false))).toBe('no-credential');
    expect(userStatus(u('d', 'D', 'it', null, false, false))).toBe('no-credential'); // no credential wins
  });
  it('builds initials from the first and last word, one word stays single', () => {
    expect(initials('Camille Martin')).toBe('CM');
    expect(initials('Inès Roux')).toBe('IR');
    expect(initials('Madonna')).toBe('M');
    expect(initials('')).toBe('?');
  });
  it('colors departments deterministically and distinctly for close names', () => {
    expect(deptColor('finance')).toBe(deptColor('finance'));
    expect(deptColor('finance')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(new Set(['it', 'hr', 'sales', 'finance', 'legal'].map(deptColor)).size).toBeGreaterThan(2);
  });
  it('filters by text, department and status together', () => {
    expect(filterUsers(USERS, { q: '', dept: '', status: '' })).toHaveLength(5);
    expect(filterUsers(USERS, { q: 'camille', dept: '', status: '' }).map((x) => x.id)).toEqual(['camille-martin']);
    expect(filterUsers(USERS, { q: '', dept: 'finance', status: '' }).map((x) => x.id)).toEqual(['demo-bob', 'camille-martin']);
    expect(filterUsers(USERS, { q: '', dept: '', status: 'no-credential' }).map((x) => x.id)).toEqual(['ines-roux']);
    expect(filterUsers(USERS, { q: '', dept: '', status: 'disabled' }).map((x) => x.id)).toEqual(['tom-garnier']);
    expect(filterUsers(USERS, { q: 'garnier', dept: 'sales', status: 'disabled' }).map((x) => x.id)).toEqual(['tom-garnier']);
    expect(filterUsers(USERS, { q: 'garnier', dept: 'it', status: '' })).toHaveLength(0);
    expect(filterUsers(USERS, { q: 'ROUX@EXAMPLE', dept: '', status: '' }).map((x) => x.id)).toEqual(['ines-roux']); // e-mail, case-insensitive
  });
  it('sorts by name, department or status, ascending and descending', () => {
    expect(sortUsers(USERS, 'name', 1).map((x) => x.id)).toEqual(['demo-alice', 'demo-bob', 'camille-martin', 'ines-roux', 'tom-garnier']);
    expect(sortUsers(USERS, 'name', -1)[0].id).toBe('tom-garnier');
    expect(sortUsers(USERS, 'dept', 1).map((x) => x.department)).toEqual(['finance', 'finance', 'it', 'it', 'sales']);
    expect(sortUsers(USERS, 'status', 1).map((x) => userStatus(x))).toEqual(['enabled', 'enabled', 'enabled', 'disabled', 'no-credential']);
    expect(sortUsers(USERS, 'status', -1)[0].id).toBe('ines-roux');
  });
  it('resolves the manager and the direct reports for the chain', () => {
    const c = managerChain(USERS[2], USERS);
    expect(c.manager?.id).toBe('demo-alice');
    expect(c.reports.map((x) => x.id)).toEqual(['ines-roux', 'tom-garnier']); // sorted by name
    expect(managerChain(USERS[0], USERS).manager).toBeNull();
    expect(managerChain(USERS[4], USERS).reports).toHaveLength(0);
    const orphan = u('z', 'Zed', 'it', 'ghost'); // manager id not in the list: no crash, no node
    expect(managerChain(orphan, USERS).manager).toBeNull();
  });
  it('counts users, sign-in enabled, missing credentials and departments', () => {
    expect(userStats(USERS)).toEqual({ total: 5, enabled: 3, noCred: 1, depts: 3 });
    expect(userStats([])).toEqual({ total: 0, enabled: 0, noCred: 0, depts: 0 });
  });
});
