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

## Templates screen (Messaging > Templates)

The mail-templates plugin ships the admin screen (gallery + editor), a packaged custom element.

- Gallery: one card per mail type, the global layout first - live HTML preview rendered by the API through the
  notify.templates slot, default/customized badge, Edit, Restore default, Send test (per-card recipient).
- Editor: full page - subject, Text/HTML tabs, one sample-data field per declared variable (used for the preview
  and the tests), live preview of the UNSAVED draft (POST preview), save on the working branch.
- Layout editor: the HTML shell (must keep {{body}}) plus the layout variables (logo, logoUrl, brandColor,
  pageBg, footer); the preview renders a sample mail inside the draft shell.
- main stays read only: choose a working branch to customize, then Apply to go live.


## User-created workflow templates (v1)

The existing Templates plugin can also create definitions named `custom.<name>`, with a display name,
subject, text, optional HTML, and typed parameters. Parameter types are `text` and `temporary-password`.
Definitions use a tagged `workflow-template/v1` envelope in the existing versioned storage. Older layout
variables and plugin-declared customizations keep their existing format.

Creation, edits and deletion require the normal admin capability and a writable selected branch.
The main branch remains read-only. Review and Apply publish the definition together with the workflow.
Deleting an owned definition does not create a plugin fallback. A workflow referencing it fails closed.

The new `lyam-send-template-mail` block selects a template and a reviewed revision. Its schema creates
parameter inputs in the inspector. Create and Edit links open Templates in a separate tab so the workflow
canvas remains open. After editing, Refresh templates, review the new revision, and refill parameters.
Revision review resets parameters deliberately. The revision includes the shared layout, so changing a
layout requires reviewing workflows that use it too. Save and real execution reject stale revisions.

Ordinary text mail does not require a credential, account block or publication proof. Temporary-password
parameters do: graph configuration accepts only an upstream `passwordRef` placeholder, execution accepts
only the run-owned opaque reference, and actual values never enter template previews or the renderer bus.
Temporary-password templates are plain text only, cannot put the password in the subject, cannot send a
test, and must include the password parameter and `{{expiry}}` in the text. `expiry` and optional `hours`
are derived from the checked live credential, not user-supplied values. The recipient, credential revision,
first-access expiry, published and activated head, and creation-run ownership of account blocks are checked
before delivery. The approved-reset path remains frozen, including when using this new block.

Delivery records durable intent before the provider call, and durable accepted output before downstream
steps. Provider acceptance is not inbox delivery. A crash or uncertain provider result stops for manual
review, including error branches; it never automatically resends or unblocks the account.

### Existing graphs and an explicit migration

Existing `lyam-send-mail` and `lyam-send-secret-mail` graphs keep their current contracts and are not rewritten.
No live definition, trigger or paused flag is changed by installing this feature. To migrate a paused badge
workflow, create a plain-text owned template with one temporary-password parameter and an expiry parameter.
On a review branch replace only the legacy mail node, preserve its node id and all edges, map `passwordRef`
to `param_<password parameter>`, and preserve `to`, `account`, `hours`, `revision`, `sourceHead` and `ownerRun`.
Select the reviewed template revision and publish the template and workflow together after review.
The engine recognizes both forms for badge feasibility checks before ticket claim. The mail-acceptance to
owned-unblock edge stays unchanged. Never activate or execute a migrated graph as part of this conversion.

Tests use fictional local data and fake provider calls. The persistence test exercises real Dolt branch and
tenant isolation, service recreation, deletion and main publication, not an external email delivery.
