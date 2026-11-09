import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COLORS, THEME_VARIABLES, cssString, generateTheme, logoColors, themeCss } from './theme-engine.js';

/** Theme engine contract (docs/branding.md step 2): both modes fill every variable of the contract, the
 * derivation is deterministic, and the served CSS carries the three blocks the pages rely on. */
describe('branding theme engine', () => {
  const theme = generateTheme(DEFAULT_COLORS);

  it('fills every variable of the contract in both modes, as hex colors', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const k of THEME_VARIABLES) {
        const v = theme[mode][k];
        assert.ok(v, `${mode} ${k} missing`);
        assert.match(v, /^#[0-9a-f]{6}([0-9a-f]{2})?$/, `${mode} ${k} = ${v}`);
      }
    }
  });

  it('is deterministic and reacts to both source colors', () => {
    assert.deepEqual(generateTheme(DEFAULT_COLORS), theme);
    const other = generateTheme({ primary: '#b91c1c', accent: '#f59e0b' });
    assert.notEqual(other.light['--accent'], theme.light['--accent']);
    assert.notEqual(other.light['--chip-bg'], theme.light['--chip-bg']);
    // The neutral palettes follow the primary hue: a red primary warms the greys.
    assert.notEqual(other.light['--bg'], theme.light['--bg']);
  });

  it('keeps near-achromatic source colors usable (grey but complete theme)', () => {
    for (const primary of ['#ffffff', '#000000', '#808080']) {
      const t = generateTheme({ primary, accent: '#cccccc' });
      for (const k of THEME_VARIABLES) assert.match(t.light[k], /^#[0-9a-f]{6}/, `${primary} ${k}`);
    }
  });

  it('emits the three CSS blocks and the escaped text slots', () => {
    const css = themeCss(theme, { baseline: 'IAM next "gen" \\ <x>\nline', footer: 'ACME ©' });
    assert.match(css, /:root\{color-scheme:light;--brand-baseline:/);
    assert.match(css, /:root\[data-theme='dark'\]\{color-scheme:dark;/);
    assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme='light'\]\)\{color-scheme:dark;/);
    assert.ok(css.includes('--brand-baseline:"IAM next \\"gen\\" \\\\ \\3C x> line";'), css.match(/--brand-baseline:[^;]*;/)?.[0] ?? 'no baseline slot');
    assert.ok(css.includes('--brand-footer:"ACME ©";'));
    // every variable of the contract appears in the light block
    const light = css.split('\n')[0];
    for (const k of THEME_VARIABLES) assert.ok(light.includes(`${k}:`), k);
  });

  it('escapes CSS string breakers', () => {
    assert.equal(cssString('a"b\\c'), 'a\\"b\\\\c');
    assert.equal(cssString('l1\nl2\rl3\fl4'), 'l1 l2 l3 l4');
    assert.equal(cssString('<script>'), '\\3C script>');
  });

  it('derives logo colors for both variants', () => {
    for (const v of ['light', 'dark'] as const) {
      const l = logoColors(DEFAULT_COLORS, v);
      for (const k of ['gradientFrom', 'gradientTo', 'wordmark', 'branch', 'glyph'] as const) assert.match(l[k], /^#[0-9a-f]{6}$/, `${v}.${k}`);
    }
  });
});
