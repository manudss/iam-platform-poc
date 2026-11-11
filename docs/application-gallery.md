# My applications

The gallery lists only live, enabled applications permitted by the signed-in person's roles and by the active SSO provider. It keeps the existing OIDC launch URLs and SAML IdP-initiated links. Company wiki and the other legacy connectors are not removed.

## Application identity

Administrators upload PNG, JPEG or WebP (64 KB maximum) or inert SVG (50 KB maximum). Remote image URLs are not accepted. Artwork is stored as a data URI in `app_connectors.config`, in Dolt on the administrator's selected branch. It follows normal diff, review and Apply. No object storage or external image service is required. Remove logo restores the initials fallback; failed image loads use the same fallback.

SVG is parsed and rebuilt from a small element/attribute vocabulary. Scripts, events, styles, foreign content, declarations, entities and external references are rejected. Images are only rendered as `<img>`, never HTML. Raster signatures are checked; a browser decode failure falls back to initials.

The existing demo seed embeds assets from `plugins/app-connector/seed-assets/`. The seed is the only provisioning route; opening the page never writes application configuration. Existing non-seeded connectors without artwork remain supported.

## Personal preferences

Stars add/remove favourites. Favourites are shown once, in the first section, with other apps below. Organise edits both section orders on the page, with pointer drag handles (mouse or touch) and labelled up/down buttons. Apps do not launch in edit mode. Save order confirms; Cancel discards draft stars and order. Search is disabled during organisation so hidden cards cannot be reordered accidentally.

Preferences are stored in the existing live profile value store under the reserved, non-schema `console.launchpad` key, scoped to authenticated tenant and subject. They survive reloads and follow the user between devices. They are personal live writes, not administrator changes awaiting Apply. The API accepts only accessible app IDs and no target identity; stale IDs are filtered out on read. Branch-test tokens cannot read/write this live launchpad. Demo restarts remain ephemeral by design.

Descriptions are clamped to three lines visually, without hover popups. The full text remains in the document for assistive technology. Buttons have 44px targets, pressed state, live reorder announcements and focus restoration. At 320px the handle has a separate row to preserve touch target size.

## Checks

- API: `npm test` in `apps/api` (the repo's required service binaries enable real-service tests).
- Web: `npm test -- --watch=false` and `npm run build` in `apps/web`.
- Browser: `NODE_PATH=/path/to/playwright/node_modules CHROME_BIN=/path/to/chrome node scripts/gallery-e2e.mjs http://localhost:8080 /tmp/gallery-shots` against a seeded isolated demo. The demo-docker CI job runs it automatically.
- The browser check covers stars, reload persistence, search, Cancel, move buttons, pointer drag, Save, themes, 320/390px layouts, admin upload, Dolt staging/Apply and another user's isolation. Screenshot artifacts are uploaded by CI.
