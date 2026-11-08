# Create a plugin

The everything-is-a-plugin walkthrough: scaffold, declare, code, sign, validate, test, enable.
Background reading: `docs/plugins.md` (kinds, hooks, bases/replacements), `docs/plugin-contract-v2.md`
(bus protocol), `docs/plugins-dependencies.md` (dependency ownership).

## 1. Scaffold

```sh
node scripts/plugin-create.mjs my-notifier --name "My notifier" --kind notifier --hook notify.send
```

This creates `plugins/my-notifier/` with three files:

| File | Role |
| --- | --- |
| `manifest.json` | The contract: id, kinds, hooks (+ modes), settings, entrypoints, signature flag. |
| `handlers.mjs` | The code: one export per declared hook. |
| `package.json` | The plugin's OWN dependency declaration (step 4). |

To customize an existing behavior instead, extend its **base** plugin:

```sh
node scripts/plugin-extend.mjs auth-password-base my-password-policy
```

The replacement keeps the base's hooks/settings as a superset (`plugin-validate.mjs` enforces it),
starts as thin `ctx.base[...]` wrappers, and inherits the base's declared dependencies under its own
`@iam-plugin/<id>` package name. Bases are loaded before their replacements (topological order), and
the replacement keeps the base's kinds.

## 2. Manifest (v3)

- `kinds` — one of the registered `PLUGIN_KINDS` (see `apps/api/src/plugins/v1/manifest.ts`): auth-method,
  notifier, directory, connector, workflows, sso, mcp, ui, ... A new kind is a core change: add it there
  and document it.
- `hooks` — every hook the plugin implements, with its `mode`: `async` (fire and forget) or `blocking`
  (the caller awaits a result; slot-filtered blocking hooks are also `BUS_CONTROL_KINDS` in
  `bus-host.ts`). Handlers must implement exactly the declared hooks — no more, no less.
- `settings` — admin-facing configuration schema (key, type, label, default, group). Values are
  versioned in Dolt per organization; secrets NEVER go here (see §6).
- `provides` / `extends` / `base` — the replacement chain. A base (`base: true`) ships the default
  behavior; a replacement (`extends: <base-id>`) overrides it.
- `authMethod`, `slots`, `uiComponents`, engine metadata — kind-specific blocks; copy the shape from a
  plugin of the same kind (e.g. `plugins/auth-totp/manifest.json`, `plugins/organizations/`).

## 3. Handlers

`handlers.mjs` default-exports `{ '<hook>': async (payload, ctx) => result }`.

- Everything travels over the event bus (NATS in production, a fake bridge in unit specs). A business
  refusal is a RESULT payload (`{ ok: false, ... }`); throwing marks the plugin faulted (persisted,
  audited, no silent fallback to the base).
- `ctx.base` — on a replacement, the base's handlers, for delegation (see `plugins/notify-resend`).
- `ctx.settings` — the organization's settings for this plugin.
- No top-level `await` (the loader synchronously `require()`s the folder's ESM). Import dependencies
  with `createRequire(new URL('./package.json', import.meta.url))`.

## 4. Dependencies (step 4)

Declare every external package the code imports in the plugin's `package.json`, then regenerate the
controlled shared install:

```sh
node scripts/plugin-deps.mjs            # scans plugin code, rewrites root package.json, npm install
node scripts/plugin-deps.mjs --check    # CI: declared == imported == generated
```

Packages with process-global state or identity semantics (`@nestjs/common`) are HOST-PROVIDED: the
script symlinks the API's single instance instead of installing a second copy. Add to `HOST_PROVIDED`
in `scripts/plugin-deps.mjs` only for that hazard class.

## 5. Sign and validate

```sh
node scripts/plugin-dev-setup.mjs       # dev key: signs every plugin under plugins/
node scripts/plugin-pack.mjs plugins/my-notifier   # production key
node scripts/plugin-validate.mjs        # manifest shape, hook/handler match, signature, replacement rules
```

The signature covers `manifest.json`, every code file AND `package.json`: any edit invalidates it.
Validate reads the built output, so rebuild the API first when a spec depends on it.

## 6. Secrets and environment

Never in code, never in settings, never in the data branches. Read from the server environment at call
time (`plugins/notify-resend` reads `RESEND_API_KEY`) and DEGRADE EXPLICITLY when it is missing: return
a result that says the delivery was simulated rather than pretending.

## 7. Test

- Unit: boot the registry against a fake bus (`apps/api/src/testing/test-bus.ts`), call the slot, assert
  results — see `apps/api/src/plugins/v1/business-slots.spec.ts`.
- Acceptance: every step lands with a spec that proves the invariant (see
  `apps/api/src/plugins/v1/plugin-deps.spec.ts`).
- CI runs the full `node --test dist/**/*.spec.js` suite plus the guards (`plugin-deps --check`,
  event inventory, `plugin-validate`). A single non-exiting spec hangs the whole api job — close
  handles and stop timers in `after()`.

## 8. Enable

Plugins are installed (signed folder present), then ENABLED per organization through the admin API.
Method plugins ride the `auth.*` hooks (no grants); organizations need `{ uiComponents: true }`
(console-only by design).
