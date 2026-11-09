/** Refusing base of the auth.webauthn slot: the slot always has a base, so with NO method plugin enabled every
 * call fails CLOSED - a configured chain that lost its provider can never be satisfied instead of failing open.
 * Enabling the method plugin (auth-webauthn) chooses it as the slot's replacement, exactly like auth-totp. */
const unavailable = () => { throw new Error("auth method 'webauthn' has no provider enabled on the slot"); };
export default {
  'auth.prepare': unavailable,
  'auth.verify': unavailable,
  'auth.enroll': unavailable,
  'auth.verification': () => ({ real: false, note: 'No provider enabled on this slot: the method is disabled.' }),
};
