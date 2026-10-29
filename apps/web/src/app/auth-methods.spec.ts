import { AuthnConfig, slug, suggestChainLevel } from './auth-methods';

const cfg: AuthnConfig = {
  methods: [
    { id: 'password', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
    { id: 'totp', type: 'totp', name: 'App', enabled: true, level: 7, config: {} },
  ],
  chains: [], defaultChain: null,
};

describe('authentication methods helpers', () => {
  it('suggests the strongest step as a starting level, never a sum', () => {
    expect(suggestChainLevel(cfg, ['password', 'totp'])).toBe(7);
    expect(suggestChainLevel(cfg, ['password'])).toBe(3);
    expect(suggestChainLevel(cfg, [])).toBe(1);
  });
  it('builds unique readable ids', () => {
    expect(slug('Bank digit code!', [])).toBe('bank-digit-code');
    expect(slug('Password', ['password'])).toBe('password-2');
    expect(slug('###', [])).toBe('item');
  });
});
