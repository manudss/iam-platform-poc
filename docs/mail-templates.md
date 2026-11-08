# Mail templates

Every e-mail the platform sends is a named **mail template**, declared by the plugin that owns the sending
(`manifest.mailTemplates`) and rendered by the **mail-templates-base** plugin on the `notify.templates` slot.
A special `_layout` template is the shared page shell (logo, brand colors, footer) every e-mail body is wrapped in.
The **mail-templates** plugin (step 2) is the management UI and per-tenant, per-branch overrides.

## Rendering pipeline

1. A sender calls `renderMail(registry, tenant, templateKey, data)` (`plugins/v1/mail-catalogue.ts`).
   The catalogue lists every declared template (`mailCatalogue()`), layout first.
2. That emits a **blocking** `notify.render` call, slot-targeted at `notify.templates`, over the application bus.
   `mail-templates-base` is the base plugin for the slot: pure interpolation of `{{variable}}` placeholders,
   values HTML-escaped in `html`, raw in `subject`/`text`, the rendered `html` injected at `{{body}}` inside the
   layout shell. Layout variables (logo, colors, footer) are admin-owned, so they render raw.
3. A `notify.send` event then carries the rendered `subject`/`text`/`html` alongside the raw `template`/`data`;
   delivery plugins (`notify-resend`) use the rendered fields when present and keep the legacy raw payload otherwise.
4. If the slot has no replacement and the base is unavailable (or the bus refuses the call), the send
   **degrades to the legacy raw payload with a log line** — rendering must never block a sign-in.

Declaring `mailTemplates` in a new plugin's manifest automatically makes that mail type appear in the catalogue
and the Templates UI; nothing else to wire.

## Declaring a template

```jsonc
"mailTemplates": [
  { "key": "sign-in-code", "name": "Sign-in code",
    "description": "One-time code sent at sign-in.",
    "variables": ["code", "ttlMinutes", "subjectUser"],
    "default": { "subject": "Your sign-in code: {{code}}", "text": "…", "html": "…" } }
]
```

- `key` is unique across all plugins (`_layout` is reserved for the global shell, `layout: true`).
- `variables` are the keys a sender MUST put in `data`; the default subject/text must only use declared variables.
- `default.subject` and `default.text` are required; `default.html` is optional (HTML-capable deliveries wrap it in the layout).

The layout template carries `default.html` with a `{{body}}` placeholder and its own variables
(`logo`, `logoUrl`, `brandColor`, `pageBg`, `footer`); `footer` also joins plain-text bodies after a `-- ` separator.

## Current mail types

| key | plugin | trigger | delivery |
| --- | --- | --- | --- |
| `sign-in-code` | auth-email-otp | sign-in challenge (e-mail OTP) | `notify.default` slot (Resend / log) |
| `signup-confirmation` | directory | sign-up request | `notify.default` when its capability is real, else demo outbox (live path, main registry) |
| `role.changed` | directory | role granted/revoked on a working branch, activation state in the message | `notify.default` slot |
| `workflow.notify` | workflows-iga | workflow notification effect | simulated (`notify-log` today) |
| `_layout` | mail-templates-base | — shared shell | — |

## Management API (tenants/:tenant/mail-templates)

The Templates screen drives this console API (signed-in read, admin capability to change anything). A
customization lives on the working data branch (`plg_mail_templates_custom`, one row per template and
language) and goes live on Apply, like every other administrator change; `main` is read-only.

- `GET /` - the catalogue merged with the branch customizations (`customized` badge + effective content).
- `GET /:key` - default vs override vs effective for one template.
- `PUT /:key` - save a customization (`{subject, text, html?}`; `_layout` takes `{html, vars}` and must keep
  `{{body}}`). Variables outside the declaration are refused.
- `DELETE /:key` - restore the plugin default.
- `POST /preview` - render without saving: `{key, data?, override?, layoutOverride?}` (the editor live preview).
- `POST /:key/send-test` - render with the branch customization and send one e-mail through the
  `notify.default` slot (`{to, data?}`); the answer says whether the slot really delivers.
