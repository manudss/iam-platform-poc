import { Hct, TonalPalette, argbFromHex, hexFromArgb } from '@material/material-color-utilities';

/**
 * Theme engine (docs/branding.md step 2): from the TWO source colors of the branding settings (primary +
 * accent) derive EVERY color of the interface with Material You color science (HCT tonal palettes), for the
 * light and the dark mode, mapped onto the console's CSS-variable contract (apps/web/src/styles.css).
 *
 * Pure module: no Nest, no I/O. Unit-tested on its own, contrast-tested in contrast.spec.ts.
 *
 * Roles follow Material You: surfaces and inks come from the neutral / neutral-variant palettes of the
 * primary hue at low chroma; interactive colors from the primary palette; chips from the secondary (accent)
 * palette; ok/bad/warn from fixed semantic hues. Text roles sit on Material's contrast-safe tone pairs, so the
 * pairs stay WCAG AA whatever the source colors (the tone, not the source hex, carries the role).
 */

export interface BrandingColors { primary: string; accent: string }

export const DEFAULT_COLORS: BrandingColors = { primary: '#4f46e5', accent: '#818cf8' };

/** Every variable the engine emits, per mode. The CSS pass (step 8) may only use variables of THIS list. */
export const THEME_VARIABLES = [
  '--bg', '--card', '--panel', '--code-bg', '--th-bg', '--row-hover', '--field-bg', '--bar-off',
  '--veil', '--card-auth', '--auth-field',
  '--ink', '--muted', '--label', '--brand-sub', '--th-ink',
  '--line', '--field-line', '--focus',
  '--accent', '--accent-ink', '--accent-dark', '--accent-soft', '--link',
  '--chip-bg', '--chip-ink',
  '--ok', '--ok-soft', '--ok-line', '--bad', '--bad-soft', '--bad-ink', '--bad-line',
  '--warn-soft', '--warn-line', '--warn-ink',
  '--sel', '--on-bad', '--sidebar-bg', '--sidebar-ink', '--sidebar-muted', '--sidebar-active', '--sidebar-hover', '--gradient-from', '--gradient-to', '--scrim', '--shadow-color',
] as const;
export type ThemeVariable = (typeof THEME_VARIABLES)[number];
export type ThemeVars = Record<ThemeVariable, string>;

export interface GeneratedTheme { light: ThemeVars; dark: ThemeVars }

// The tone of the seed Hct is irrelevant: the palette generates every tone from hue + chroma.
function palette(hue: number, chroma: number): TonalPalette { return TonalPalette.fromHct(Hct.from(hue, chroma, 50)); }
function hex(p: TonalPalette, tone: number): string { return hexFromArgb(p.tone(tone)); }
/** #rrggbb with an alpha suffix (#rrggbbaa): translucent surfaces (veil, auth cards) keep their fixed alpha. */
function hexa(p: TonalPalette, tone: number, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
  return `${hex(p, tone)}${a}`;
}

export interface Palettes { primary: TonalPalette; secondary: TonalPalette; neutral: TonalPalette; neutralVariant: TonalPalette; ok: TonalPalette; bad: TonalPalette; warn: TonalPalette }

/** The five palettes of a theme: primary/accent from the source colors, neutrals from the primary hue at
 * Material's low chromas, and the fixed semantic hues (green / Material error red / amber). */
export function palettesOf(colors: BrandingColors): Palettes {
  const p = Hct.fromInt(argbFromHex(colors.primary));
  const a = Hct.fromInt(argbFromHex(colors.accent));
  return {
    primary: palette(p.hue, Math.min(p.chroma, 48)),
    secondary: palette(a.hue, Math.min(a.chroma, 24)),
    neutral: palette(p.hue, Math.min(p.chroma / 12, 8)),
    neutralVariant: palette(p.hue, Math.min(p.chroma / 8 + 4, 24)),
    ok: palette(145, 32),
    bad: palette(25, 84),
    warn: palette(80, 32),
  };
}

/** One mode of the theme: the variable contract filled from the palettes. */
function modeVars(pl: Palettes, dark: boolean): ThemeVars {
  const { primary: P, secondary: S, neutral: N, neutralVariant: NV, ok: G, bad: E, warn: W } = pl;
  return dark ? {
    '--bg': hex(N, 6), '--card': hex(N, 10), '--panel': hex(N, 15), '--code-bg': hex(N, 20),
    '--th-bg': hex(NV, 20), '--row-hover': hex(N, 17), '--field-bg': hex(N, 15), '--bar-off': hex(NV, 30),
    '--veil': hexa(N, 6, .60), '--card-auth': hex(N, 12), '--auth-field': hex(N, 8),
    '--ink': hex(N, 90), '--muted': hex(NV, 75), '--label': hex(NV, 80), '--brand-sub': hex(NV, 75), '--th-ink': hex(NV, 75),
    '--line': hex(NV, 25), '--field-line': hex(NV, 55), '--focus': hex(P, 70),
    '--accent': hex(P, 80), '--accent-ink': hex(P, 20), '--accent-dark': hex(P, 70), '--accent-soft': hex(P, 25), '--link': hex(P, 80),
    '--chip-bg': hex(S, 30), '--chip-ink': hex(S, 90),
    '--ok': hex(G, 80), '--ok-soft': hex(G, 25), '--ok-line': hex(G, 40),
    '--bad': hex(E, 80), '--bad-soft': hex(E, 25), '--bad-ink': hex(E, 90), '--bad-line': hex(E, 40),
    '--warn-soft': hex(W, 25), '--warn-line': hex(W, 45), '--warn-ink': hex(W, 90),
    '--sel': hex(P, 30), '--on-bad': hex(E, 20),
    '--sidebar-bg':hex(P,10),'--sidebar-ink':hex(N,95),'--sidebar-muted':hex(NV,80),'--sidebar-active':hex(P,30),'--sidebar-hover':hex(P,20),
    '--gradient-from':hex(S,80),'--gradient-to':hex(P,55),'--scrim':hexa(N,0,.55),'--shadow-color':hexa(N,0,.25),
  } : {
    '--bg': hex(N, 98), '--card': hex(N, 100), '--panel': hex(N, 96), '--code-bg': hex(N, 94),
    '--th-bg': hex(NV, 92), '--row-hover': hex(N, 95), '--field-bg': hex(N, 100), '--bar-off': hex(NV, 85),
    '--veil': hexa(N, 98, .45), '--card-auth': hex(N, 100), '--auth-field': hex(N, 100),
    '--ink': hex(N, 10), '--muted': hex(NV, 45), '--label': hex(NV, 30), '--brand-sub': hex(NV, 45), '--th-ink': hex(NV, 40),
    '--line': hex(NV, 88), '--field-line': hex(NV, 55), '--focus': hex(P, 45),
    '--accent': hex(P, 40), '--accent-ink': hex(P, 100), '--accent-dark': hex(P, 30), '--accent-soft': hex(P, 92), '--link': hex(P, 40),
    '--chip-bg': hex(S, 90), '--chip-ink': hex(S, 30),
    '--ok': hex(G, 40), '--ok-soft': hex(G, 90), '--ok-line': hex(G, 75),
    '--bad': hex(E, 40), '--bad-soft': hex(E, 90), '--bad-ink': hex(E, 30), '--bad-line': hex(E, 75),
    '--warn-soft': hex(W, 92), '--warn-line': hex(W, 70), '--warn-ink': hex(W, 25),
    '--sel': hex(P, 85), '--on-bad': hex(E, 100),
    '--sidebar-bg':hex(P,10),'--sidebar-ink':hex(N,95),'--sidebar-muted':hex(NV,80),'--sidebar-active':hex(P,30),'--sidebar-hover':hex(P,20),
    '--gradient-from':hex(S,70),'--gradient-to':hex(P,40),'--scrim':hexa(N,0,.55),'--shadow-color':hexa(N,0,.15),
  };
}

/** The whole theme for a pair of source colors: both modes, every variable of the contract. */
export function generateTheme(colors: BrandingColors): GeneratedTheme {
  const pl = palettesOf(colors);
  return { light: modeVars(pl, false), dark: modeVars(pl, true) };
}

/** Escapes a free-text branding value (baseline, footer) for a CSS string slot. */
export function cssString(s: string): string {
  return s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, ' ').replace(/</g, '\\3C ');
}

/** Text slots the no-JS pages (Rust-core sign-in frame) render through CSS `content` (docs/branding.md §6). */
export interface BrandingTexts { baseline: string; footer: string }

function varDecls(vars: ThemeVars): string { return THEME_VARIABLES.map((k) => `${k}:${vars[k]};`).join(''); }

/** The served theme.css: light defaults, the dark override, and the system-preference fallback for pages
 * whose data-theme is unset. Text slots are emitted once on :root (they do not depend on the mode). */
export function themeCss(theme: GeneratedTheme, texts: BrandingTexts): string {
  const text = `--brand-baseline:"${cssString(texts.baseline)}";--brand-footer:"${cssString(texts.footer)}";`;
  return [
    `:root{color-scheme:light;${text}${varDecls(theme.light)}}`,
    `:root[data-theme='dark']{color-scheme:dark;${varDecls(theme.dark)}}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme='light']){color-scheme:dark;${varDecls(theme.dark)}}}`,
  ].join('\n');
}

/** Logo palette (docs/branding.md §4): the shield gradient runs accent -> primary, the wordmark is the ink
 * color, the y-branch the primary, the glyph the on-primary. One set per logo variant. */
export interface LogoColors { gradientFrom: string; gradientTo: string; wordmark: string; branch: string; glyph: string }
export function logoColors(colors: BrandingColors, variant: 'light' | 'dark'): LogoColors {
  const pl = palettesOf(colors);
  return variant === 'dark'
    ? { gradientFrom: hex(pl.secondary, 80), gradientTo: hex(pl.primary, 55), wordmark: hex(pl.neutral, 90), branch: hex(pl.primary, 75), glyph: hex(pl.primary, 20) }
    : { gradientFrom: hex(pl.secondary, 70), gradientTo: hex(pl.primary, 40), wordmark: hex(pl.neutral, 10), branch: hex(pl.primary, 45), glyph: '#ffffff' };
}
