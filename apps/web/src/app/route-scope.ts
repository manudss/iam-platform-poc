/** Personal and sign-in pages must never start administration work or react to its stale requests. */
export function isPersonalArea(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return path === '/' || ['/my-applications', '/my-profile', '/access-denied', '/step-up', '/sso-interaction', '/sso-saml', '/login', '/callback', '/signup', '/privacy', '/about', '/admin-preview'].some((p) => path === p || path.startsWith(p + '/'));
}
