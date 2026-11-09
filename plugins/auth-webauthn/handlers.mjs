/**
 * Passkey (WebAuthn / FIDO2) sign-in method, on top of the reference library SimpleWebAuthn
 * (@simplewebauthn/server, MIT): the ceremonies are the W3C WebAuthn Level 2/3 ones, the FIDO2
 * server side. The plugin is PURE (bus-safe contract, step 2): the enrolled credentials, the clock
 * and the origin come IN THE PAYLOAD (read core-side); the anti-clone counter advance is returned as
 * an effect (`credentialCounter`) the core applies atomically after an ok.
 *
 * Two ceremonies:
 *  - sign-in  (auth.prepare / auth.verify): a per-attempt challenge is signed by the authenticator;
 *             the signature is bound to the origin and the RP id, so it cannot be replayed or phished
 *             on another site. Challenge single use and expiry are enforced through the state.
 *  - enroll   (auth.enroll, mode options/verify): the attestation that creates the credential,
 *             orchestrated by the self-service controller (the person's own session, never an admin).
 *
 * RP id: `host` mode derives it from the sign-in page host (demos, per-PR previews, custom domains
 * work with no setup; the page origin is passed by the core); `fixed` mode pins one RP id and an
 * explicit origin allowlist (production style). Attestation defaults to `none` (what Apple and
 * Google ask for); `direct` asks the authenticator to prove its model, but statements are NOT
 * checked against the FIDO metadata service in this POC.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('./package.json', import.meta.url));
const { generateAuthenticationOptions, verifyAuthenticationResponse, generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');

/** ES256, EdDSA, RS256 (COSE ids): the algorithms SimpleWebAuthn checks by default. */
const ALGOS = [-7, -8, -257];
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

/** The RP id and the exact origin the ceremony must be bound to, from the instance settings and the
 * page origin the core passed. Returns { rpId, origin } or throws a BUSINESS refusal as data below. */
function relyingParty(config, pageOrigin) {
  const mode = String(config.originMode ?? 'host');
  let host = '';
  try { host = new URL(String(pageOrigin ?? '')).hostname; } catch { host = ''; }
  if (mode === 'fixed') {
    const rpId = String(config.rpId ?? '').trim();
    const origins = String(config.origins ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    if (!rpId || !origins.length) return { error: 'the fixed relying-party mode needs an RP id and at least one allowed origin' };
    if (!origins.includes(pageOrigin)) return { error: `the origin ${pageOrigin || '(none)'} is not in this method's allowed origins` };
    return { rpId, origin: pageOrigin };
  }
  if (!host) return { error: 'the sign-in page origin is missing: the passkey ceremony cannot start' };
  return { rpId: host, origin: String(pageOrigin) };
}

const timeoutMs = (config) => Math.min(300, Math.max(15, Number(config.timeoutSeconds ?? 60))) * 1000;
const uv = (config) => ['preferred', 'required', 'discouraged'].includes(config.userVerification) ? config.userVerification : 'preferred';

export default {
  'auth.verification': () => ({ real: true, note: 'Real FIDO2/WebAuthn ceremony (SimpleWebAuthn): the authenticator signs a per-attempt challenge bound to this origin with the credential private key; the signature, RP id and anti-clone counter are checked. Phishing-resistant possession factor.' }),

  /** First page of a passkey step: the request options (challenge, allowed credentials) for the
   * core-rendered ceremony, and the private state the verify call checks later. */
  'auth.prepare': async (p) => {
    const rp = relyingParty(p.config, p.origin);
    if (rp.error) return { prompt: { title: 'Passkey', message: `This method is misconfigured: ${rp.error}.`, fields: [] }, state: { broken: true } };
    const creds = (p.known ? p.enrollment?.webauthn?.credentials : undefined) ?? [];
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      timeout: timeoutMs(p.config),
      userVerification: uv(p.config),
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
    });
    const now = Number(p.now ?? Date.now());
    return {
      prompt: {
        title: 'Passkey',
        message: 'Confirm with this device: fingerprint, face, device PIN or security key. The check is bound to this site, so a fake page cannot reuse it.',
        fields: [{ name: 'webauthn', label: 'Passkey', type: 'webauthn', options }],
      },
      state: { challenge: options.challenge, origin: rp.origin, rpId: rp.rpId, exp: now + timeoutMs(p.config) + 30_000, used: false },
    };
  },

  'auth.verify': async (p) => {
    const st = p.state ?? {}, now = Number(p.now ?? Date.now());
    if (!p.known || st.used || st.broken || typeof st.challenge !== 'string' || now > Number(st.exp ?? 0)) return { ok: false };
    const raw = p.answers?.webauthn;
    if (typeof raw !== 'string' || raw.length > 16384) return { ok: false };
    let response;
    try { response = JSON.parse(raw); } catch { return { ok: false }; }
    const creds = p.enrollment?.webauthn?.credentials ?? [];
    const cred = creds.find((c) => c.id === response?.id);
    if (!cred) return { ok: false };   // a credential this account never enrolled
    let out;
    try {
      out = await verifyAuthenticationResponse({
        response,
        expectedChallenge: st.challenge,
        expectedOrigin: st.origin,
        expectedRPID: st.rpId,
        credential: { id: cred.id, publicKey: fromB64u(cred.publicKey), counter: Number(cred.counter ?? 0), transports: cred.transports },
        requireUserVerification: uv(p.config) === 'required',
      });
    } catch { return { ok: false }; }   // verification errors are business failures (bad signature, origin, rpId...)
    if (!out.verified) return { ok: false };
    return {
      ok: true,
      state: { ...st, used: true },   // the challenge can never be spent twice
      credentialCounter: { id: cred.id, counter: Number(out.authenticationInfo.newCounter ?? 0) },
    };
  },

  /** Enrollment ceremony (the self-service controller orchestrates; the person is signed in).
   * mode 'options': the creation options + the challenge the controller stores for a few minutes.
   * mode 'verify':  the attestation check -> the credential record the controller stores. */
  'auth.enroll': async (p) => {
    if (p.mode === 'options') {
      const rp = relyingParty(p.config, p.origin);
      if (rp.error) return { ok: false, reason: rp.error };
      const subject = String(p.subject ?? '');
      const options = await generateRegistrationOptions({
        rpName: String(p.config.rpName ?? 'IAM'),
        rpID: rp.rpId,
        userName: subject,
        userDisplayName: String(p.displayName ?? subject),
        timeout: timeoutMs(p.config),
        attestationType: p.config.attestation === 'direct' ? 'direct' : 'none',
        excludeCredentials: (p.existing ?? []).map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: {
          residentKey: ['preferred', 'required', 'discouraged'].includes(p.config.residentKey) ? p.config.residentKey : 'preferred',
          userVerification: uv(p.config),
        },
        supportedAlgorithmIDs: ALGOS,
      });
      return { ok: true, options, challenge: options.challenge, origin: rp.origin, rpId: rp.rpId };
    }
    if (p.mode === 'verify') {
      if (typeof p.challenge !== 'string' || !p.credential || typeof p.credential !== 'object') return { ok: false, reason: 'missing enrollment challenge or credential' };
      let out;
      try {
        out = await verifyRegistrationResponse({
          response: p.credential,
          expectedChallenge: p.challenge,
          expectedOrigin: String(p.origin ?? ''),
          expectedRPID: String(p.rpId ?? ''),
          requireUserVerification: uv(p.config) === 'required',
          supportedAlgorithmIDs: ALGOS,
        });
      } catch (e) { return { ok: false, reason: `the authenticator answer was refused: ${(e && e.message) || 'verification failed'}` }; }
      if (!out.verified || !out.registrationInfo) return { ok: false, reason: 'the authenticator answer was refused' };
      const info = out.registrationInfo;
      return {
        ok: true,
        record: {
          id: info.credential.id,
          publicKey: b64u(info.credential.publicKey),
          counter: Number(info.credential.counter ?? 0),
          transports: info.credential.transports,
          aaguid: info.aaguid,
          deviceType: info.credentialDeviceType,
          backedUp: !!info.credentialBackedUp,
        },
      };
    }
    return { ok: false, reason: `unknown enroll mode ${p.mode}` };
  },
};
