/** Framing policy of the demo edge. Only the Customisation live previews may be framed, and only by the same origin:
 * /login?preview=1 (the sign-in mock) and /admin-preview?preview=1 (the admin console mock). Every other HTML
 * response refuses framing. */
export function framingHeaders(pathname, search) {
  const preview = (pathname === '/login' || pathname === '/admin-preview') && new URLSearchParams(search).get('preview') === '1';
  return preview
    ? { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' }
    : { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };
}
