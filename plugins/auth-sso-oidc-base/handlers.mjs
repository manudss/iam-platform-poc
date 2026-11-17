/** Refusing base of the auth.sso-oidc slot (step 2): the slot always has a base, so with NO method plugin enabled
 * every call fails CLOSED - a configured sign-in method that lost its provider can never be satisfied instead of
 * failing open. Enabling the method plugin (auth-sso-oidc) chooses it as the slot's replacement. */
const unavailable = () => { throw new Error("auth method 'sso-oidc' has no provider enabled on the slot"); };
export default {
  'auth.prepare': unavailable,
  'auth.external.start': unavailable,
  'auth.external.verify': unavailable,
  'auth.verification': () => ({ real: false, note: 'No provider enabled on this slot: the method is disabled.' }),
};
