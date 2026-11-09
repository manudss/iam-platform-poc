# Branding & product customisation ("white-label" theming)

Status: plan (this document is the plan reviewed in the PR), then implementation in one PR, one commit per step.

Requested by Emmanuel (9 Nov 2026, WhatsApp): make the product customisable — pick a primary color and an
accent color, compute every color of the theme from them with Material You (Google Material Design color
science), light AND dark, contrast rules respected, everything set as CSS variables; every color used anywhere
in the app must come from one of those computed variables; the SVG logo uses the theme colors, gradients
included; a Customisation page edits the colors and the other branding parameters (name, logo, favicons,
baseline, footer, ...); the computed theme is CACHED — recomputed only when the customisation changes or when
the configuration is applied (Apply), not on every page; live preview of the interface; plan first, then build
overnight with reviews, ready for review in the morning.

## Decisions (matching the existing architecture)

1. **A plugin, like everything else.** New base plugin `branding-base` (slot `branding`, kind `ui`).
   Base plugin = always on, replaceable later ("tenant branding" is a listed plugin idea in docs/plugins.md).
   Its settings are the customisation: `productName`, `baseline`, `footer`, `primaryColor`, `accentColor`,
   `logoMode` (`default` | `custom`), `logoSvg` (custom SVG, sanitized). Settings are validated by the existing
   manifest schema and stored per Dolt branch by the existing plugin settings machinery: **a customisation is
   drafted on a working branch and goes live through Review & Apply like any other configuration.**

2. **Material You derivation, one engine.** `apps/api/src/branding/theme-engine.ts` (pure, no Nest) uses
   `@material/material-color-utilities`: primary + accent hex → HCT tonal palettes (primary from the primary
   color, secondary from the accent, neutral/neutral-variant from the primary at low chroma), Material roles
   for light and dark. Roles are mapped onto the console's existing CSS-variable contract (`--bg`, `--card`,
   `--ink`, `--accent`, ...), extended with the extra variables the CSS pass needs (focus ring, on-accent ink,
   selection, diff marks, ...). Text roles use Material's contrast-safe tone pairs (e.g. primary tone 40 /
   on-primary tone 100 in light, 80 / 20 in dark).
   **Contrast is tested**: `contrast.spec.ts` asserts WCAG AA (>= 4.5:1 for text pairs, >= 3:1 for large text
   and interactive boundaries) in both modes for a battery of source colors, extremes included (near-white,
   near-black, saturated red/yellow).

3. **Cache: recompute on change or Apply, never per page.** `BrandingService` caches the resolved profile, the
   generated `theme.css` and the logo variants keyed by `tenant | branch | Dolt head` (same pattern as the
   public sign-in options cache, `flow.service.ts`). A customisation save creates a new head on the working
   branch; an Apply creates a new head on main. Either way the key changes and the next request recomputes
   once; until then every page is served from the cache. Public endpoints carry `ETag` + short shared
   `Cache-Control` like the sign-in options; branch-test answers stay `no-store`.

4. **Public branding endpoints** (`apps/api/src/branding/branding.controller.ts`), mirroring
   `SigninOptionsController` (public on main, `branch` + `ticket` for a branch test, a branch name alone
   reveals nothing):
   - `GET /tenants/:t/branding` — JSON profile: name, baseline, footer, version hash, asset URLs.
   - `GET /tenants/:t/branding/theme.css` — the generated variables (`:root` light, `[data-theme='dark']`,
     `prefers-color-scheme` fallback), served after the static defaults so they cascade over them.
   - `GET /tenants/:t/branding/logo-horizontal-{light,dark}.svg`, `.../symbol.svg`, `.../favicon.svg` —
     the lyam logo re-rendered with the theme colors (gradient primary -> accent, wordmark in the ink color,
     y-branch in primary), or the sanitized custom SVG when `logoMode = custom`.
   - `POST /tenants/:t/branding/preview` (admin) — theme.css + logos for UNSAVED settings: the live preview.

5. **The console uses it.** `index.html` links `theme.css` after `styles.css` (defaults stay as the no-JS /
   no-API fallback); the SSR `/login` page fetches the branding profile with the sign-in options
   (TransferState, no extra round trip); the sidebar brand, the favicon links and the auth pages read the
   profile instead of the hardcoded `lyam` / `IAM next generation` strings.

6. **The Rust-core sign-in pages too** (`core/.../authz.rs`): the shared frame links the same public
   `theme.css` after its inline fallback CSS (CSP `style-src` gains `'self'`; `img-src 'self'` already covers
   the logo URLs, which move to the branding endpoints). Product texts with no JSON channel (baseline, footer)
   ride in the generated CSS as escaped `--brand-*` string variables rendered with `content` (no JS allowed by
   the frame's CSP). Inline defaults keep the pages correct if the API is unreachable.

7. **The CSS pass.** Every hardcoded color in `apps/web` (component CSS, inline styles, templates) is replaced
   by a variable of the contract; `authz.rs` gets its colors from the same variables. A guard spec fails the
   build on any hex/`rgb()`/named color outside the allowlisted defaults (`styles.css`, the theme engine, the
   demo photo URL), so the rule "every color comes from the computed variables" stays true.

8. **The Customisation screen** ships in the plugin as a packaged component screen
   (`plugins/branding-base/screens/customisation.mjs`, manifest v3 menu entry "Customisation"), in English,
   console style (no Taiga UI): identity fields (name, baseline, footer), color pickers + hex fields with a
   few presets, logo mode + custom SVG paste, favicon preview, and the **live preview**: the draft theme is
   generated through the preview endpoint and applied (a) to an iframe of the real `/login?preview=1` page
   (extending the existing `iam-preview` postMessage protocol with theme + brand fields, same-origin and
   validated as today) and (b) on demand to the admin console itself ("preview on this console" toggle, no
   save). Save goes through the normal plugin settings API (validated, branch-scoped); the screen shows the
   draft vs published state and points to Review & Apply.

9. **Tests**: theme-engine unit tests (contract completeness for light + dark, deterministic derivation),
   contrast battery, branding service cache tests (recompute only on head change), controller rules
   (public main, ticket-gated branch, no-store on tests), SVG sanitization, CSS-string escaping, web specs for
   the extended preview protocol and the profile fallback, the hardcoded-color guard spec, a Rust frame test
   (theme link present, CSP allows `'self'`), and the existing suites untouched. Manual verification on the PR
   preview with screenshots light/dark/mobile.

10. **Limits called out honestly** (POC): PNG favicon fallbacks stay the default ones (the SVG favicon is
    themed; every current browser uses it); the `<title>`/alt texts of the core pages keep the default product
    name (no JSON channel without JS); the default theme is the Material derivation of the current indigo, not
    a pixel-perfect copy of the hand-picked palette.

## Steps (one commit each)

1. This plan (`docs/branding.md`).
2. Theme engine + variable contract + contrast tests (`@material/material-color-utilities`).
3. `branding-base` plugin (manifest, settings schema, menu) + branding service/controller + cache + tests.
4. Logo/favicon generation + custom-SVG sanitization + tests.
5. Console integration (theme.css link, SSR profile, shell brand, favicons).
6. Core sign-in pages theming + Rust tests.
7. Customisation screen + live preview protocol + web specs.
8. CSS pass + hardcoded-color guard spec.
9. Preview verification, screenshots, review write-up on the PR.
