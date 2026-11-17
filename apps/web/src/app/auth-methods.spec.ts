import { AuthnConfig, drawerValue, mergedPluginValues, slug, suggestChainLevel } from './auth-methods';

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
    expect(slug('PIN keypad!', [])).toBe('pin-keypad');
    expect(slug('Password', ['password'])).toBe('password-2');
    expect(slug('###', [])).toBe('item');
  });
});

describe('plugin-scoped method form (serving plugin)', () => {
  const minLength: any = { key: 'minLength', label: 'Minimum length', type: 'number', default: 8 };
  const minClasses: any = { key: 'minClasses', label: 'Character classes', type: 'number', default: 2 };
  const serving: any = { plugin: 'auth-password-policy', settings: [minLength, minClasses], values: { minLength: 12, minClasses: 4 } };
  it('reads the serving plugin values, never the instance config', () => {
    expect(drawerValue(serving, undefined, { minLength: 99 }, minLength)).toBe(12);
    expect(drawerValue(serving, { minLength: 16 }, { minLength: 99 }, minLength)).toBe(16);
    expect(drawerValue(serving, undefined, {}, minClasses)).toBe(4);
  });
  it('falls back to the field default for values the plugin never stored', () => {
    expect(drawerValue({ plugin: 'p', settings: [], values: {} }, undefined, { minLength: 99 }, minLength)).toBe(8);
  });
  it('keeps the instance config for ordinary methods', () => {
    expect(drawerValue(undefined, undefined, { minLength: 10 }, minLength)).toBe(10);
    expect(drawerValue(undefined, { minLength: 11 }, {}, minLength)).toBe(8);
  });
  it('saves the stored values with the local edits applied, nothing from the instance config', () => {
    expect(mergedPluginValues(serving, { minLength: 16 })).toEqual({ minLength: 16, minClasses: 4 });
  });
});
