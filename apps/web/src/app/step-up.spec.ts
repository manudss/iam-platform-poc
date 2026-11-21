import { stepUpView } from './step-up';
import { SigninChain } from './api';

const ch = (id: string, name: string, level: number): SigninChain => ({ id, name, declaredLevel: level, effectiveLevel: level, mfa: false, simulated: false, recommended: false, steps: [] });
const chains = [ch('pw', 'Password', 3), ch('tot', 'Password, then authenticator', 8), ch('pk', 'Passkey', 9)];
describe('re-sign-in page wording and choices', () => {
  it('an application: names it, both levels, and lists only chains that reach the level (never the weaker one)', () => {
    const v = stepUpView({ kind: 'app', app: 'Finance', required: 8, current: 3, chains });
    expect(v.title).toBe('Finance requires a stronger sign-in');
    expect(v.detail).toContain('level 3'); expect(v.detail).toContain('level 8');
    expect(v.chains.map((c) => c.id)).toEqual(['tot', 'pk']);
    expect(v.none).toBe(false);
  });
  it('administration: names the level and says the session stays valid elsewhere', () => {
    const v = stepUpView({ kind: 'admin', app: '', required: 5, current: 3, chains });
    expect(v.title).toBe('Administration needs level 5');
    expect(v.detail).toContain('rest of your session stays valid');
  });
  it('no chain reaches the level: a separate "none" state, nothing weaker listed', () => {
    const v = stepUpView({ kind: 'app', app: 'Finance', required: 8, current: 3, chains: [chains[0]] });
    expect(v.none).toBe(true); expect(v.chains).toEqual([]);
  });
});
