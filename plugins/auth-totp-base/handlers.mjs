/** Refusing base of the auth.totp slot (step 2): the slot always has a base, so with NO method plugin enabled every
 * call fails CLOSED - a configured chain that lost its provider can never be satisfied instead of failing open.
 * Enabling the method plugin (auth-totp) chooses it as the slot's replacement, exactly like auth-password-lockout. */
const unavailable = () => { throw new Error("auth method 'totp' has no provider enabled on the slot"); };
export default {
  'auth.prepare': unavailable,
  'auth.verify': unavailable,
  'auth.verification': () => ({ real: false, note: 'No provider enabled on this slot: the method is disabled.' }),
};
