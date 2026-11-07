#!/usr/bin/env node
// Redirect URIs registered for the console's OIDC client (demo-web) in the hosted demo.
// The console builds its redirect_uri from location.origin, so every public origin the demo is
// reachable on must be registered: the IdP exact-matches this list and refuses anything else
// ("unknown client or redirect_uri" on /authorize).
//
// Origins, in order:
//   PUBLIC_ORIGIN             the canonical origin (IAM_PUBLIC_ORIGIN on the service)
//   http://localhost:4200     the local console (kept for local runs against a hosted core)
//   RENDER_EXTERNAL_URL       set by Render itself: the *.onrender.com URL, which stays reachable
//                             next to a custom domain, so both URLs keep working with zero config
//   IAM_PUBLIC_ORIGIN_EXTRA   optional comma-separated extra origins (e.g. a retired custom domain)
//
// Output: the IAM_IDP_EXTRA_REDIRECT_URIS value (comma-separated, no trailing newline).
export function redirectUris({ publicOrigin = '', renderExternalUrl = '', extraOrigins = '' } = {}) {
  const uris = [];
  const add = (origin) => {
    const o = String(origin ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/.test(o)) return;
    const u = `${o}/callback`;
    if (!uris.includes(u)) uris.push(u);
  };
  add(publicOrigin);
  add('http://localhost:4200');
  add(renderExternalUrl);
  for (const o of String(extraOrigins).split(',')) add(o);
  return uris.join(',');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  process.stdout.write(redirectUris({
    publicOrigin: process.env.PUBLIC_ORIGIN,
    renderExternalUrl: process.env.RENDER_EXTERNAL_URL,
    extraOrigins: process.env.IAM_PUBLIC_ORIGIN_EXTRA,
  }));
}
