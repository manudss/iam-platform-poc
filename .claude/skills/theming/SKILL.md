---
name: theming
description: Use whenever you add or change UI (Angular components, CSS, templates, plugin screens, Rust sign-in pages). Enforces customisation (accent colours), CSS variables only, and light/dark support.
---

# Theming skill

Read `docs/theming.md` first. Short version:

- Colours come ONLY from the CSS variables of the theme contract (`THEME_VARIABLES` in
  `apps/api/src/branding/theme-engine.ts`). No `#hex`, `rgb()`, `hsl()`, named colours, anywhere in components,
  templates, inline styles or plugin screens. Mix with `color-mix(in oklab, var(--accent) N%, var(--card))`.
- The accent and primary colours are user-chosen in Customisation. Never assume violet; never hard-code a hue.
- Every screen must work in light AND dark. Verify both, and with two different accents (default violet and teal).
- Dark surfaces are a lightness ladder (bg < panel < card < field < code < row-hover). Do not flatten it by
  reusing `--bg` for cards, and do not use pure black.
- Text >= 4.5:1 on every surface it sits on; borders and field outlines >= 3:1; card vs bg >= 1.3:1.
- New colour role: add to `THEME_VARIABLES` + both modes in `modeVars`, run `node scripts/branding-defaults.mjs`
  after building `apps/api`, add pairs to `contrast.spec.ts`.
- Before finishing: `cd apps/api && npm test` (css-contract and contrast specs) and `cd apps/web && npm test`.
