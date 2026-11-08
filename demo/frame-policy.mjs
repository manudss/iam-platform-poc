/** Framing policy of the demo edge. Only the sign-in page in preview mode (/login?preview=1) may be framed, and only by the same origin
 * (the admin page that previews the sign-in list). Every other HTML response refuses framing. */
export function framingHeaders(pathname, search) {
  const preview = pathname === '/login' && new URLSearchParams(search).get('preview') === '1';
  return preview
    ? { 'content-security-policy': "frame-ancestors 'self'", 'x-frame-options': 'SAMEORIGIN' }
    : { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' };
}
