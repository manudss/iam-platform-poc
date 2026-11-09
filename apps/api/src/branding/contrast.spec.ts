import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrandingColors, DEFAULT_COLORS, ThemeVars, generateTheme } from './theme-engine.js';

/**
 * Contrast battery (docs/branding.md step 2): every text/background pair of the theme contract must keep WCAG
 * AA (4.5:1 normal text, 3:1 for the secondary "muted" text and interactive boundaries) in BOTH modes, for a
 * battery of source colors including extremes. The tone-based roles are what make this hold for any input;
 * this spec is the proof and the regression net (a tone change that breaks AA fails here).
 */

/** WCAG relative luminance of a solid #rrggbb (alpha variables are not tested: translucent layers sit over a
 * photo background by design, their text pairs below use the solid card). */
function lum(hex: string): number {
  const c = hex.slice(1, 7);
  const ch = (i: number) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [text variable, background variable, minimum ratio] */
const PAIRS: [keyof ThemeVars, keyof ThemeVars, number][] = [
  ['--ink', '--bg', 4.5],
  ['--ink', '--card', 4.5],
  ['--ink', '--panel', 4.5],
  ['--ink', '--code-bg', 4.5],
  ['--ink', '--accent-soft', 4.5], // .msg body
  ['--ink', '--sel', 4.5], // selected text
  ['--muted', '--bg', 3], // secondary text (AA large): hints, footer
  ['--muted', '--card', 3],
  ['--label', '--field-bg', 4.5],
  ['--brand-sub', '--card', 3], // baseline under the logo (large/secondary)
  ['--th-ink', '--th-bg', 4.5],
  ['--link', '--bg', 4.5],
  ['--link', '--card', 4.5],
  ['--accent-ink', '--accent', 4.5], // primary buttons
  ['--accent-ink', '--accent-dark', 4.5], // hover state
  ['--chip-ink', '--chip-bg', 4.5],
  ['--ok', '--ok-soft', 4.5],
  ['--bad', '--bad-soft', 4.5],
  ['--bad-ink', '--bad-soft', 4.5],
  ['--warn-ink', '--warn-soft', 4.5],
  ['--accent', '--bg', 3], // interactive boundary (button edge, dots, keypad)
  // Chip borders are decorative boundaries on an already-contrasting chip (the ink pair above is the AA one);
  // kept visibly distinct, not held to the text threshold.
  ['--ok-line', '--ok-soft', 1.2],
  ['--bad-line', '--bad-soft', 1.2],
  ['--warn-line', '--warn-soft', 1.2],
];

const SOURCES: BrandingColors[] = [
  DEFAULT_COLORS,
  { primary: '#ffffff', accent: '#dddddd' },
  { primary: '#000000', accent: '#444444' },
  { primary: '#ff0000', accent: '#ff9100' },
  { primary: '#ffeb3b', accent: '#fff59d' },
  { primary: '#00c853', accent: '#69f0ae' },
  { primary: '#1a237e', accent: '#8c9eff' },
  { primary: '#ff69b4', accent: '#f8bbd0' },
  { primary: '#00695c', accent: '#4db6ac' },
];

describe('branding contrast (WCAG AA)', () => {
  for (const colors of SOURCES) {
    const label = `${colors.primary}/${colors.accent}`;
    for (const mode of ['light', 'dark'] as const) {
      it(`${mode}: all ${PAIRS.length} pairs pass for ${label}`, () => {
        const vars = generateTheme(colors)[mode];
        const failures = PAIRS
          .filter(([text]) => !vars[text].slice(7)) // skip alpha variables (none in the pairs above today)
          .map(([text, bg, min]) => ({ pair: `${text} on ${bg}`, got: ratio(vars[text].slice(0, 7), vars[bg].slice(0, 7)), min }))
          .filter((f) => f.got < f.min);
        assert.deepEqual(failures, []);
      });
    }
  }
});
