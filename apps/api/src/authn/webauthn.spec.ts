import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnrollmentStore } from './enroll-store.js';

/**
 * The passkey method plugin (plugins/auth-webauthn) tested end to end with a SOFTWARE AUTHENTICATOR built on
 * node:crypto: real ECDSA P-256 signatures, real CBOR attestation and authenticator data, so the checks of
 * SimpleWebAuthn run for real (challenge, origin, rpId hash, signature, counter). Fixtures, not a mock of the
 * library. The enrollment store tests use a temp file.
 */
const handlers = (await import(pathToFileURL(resolve(process.cwd(), '..', '..', 'plugins', 'auth-webauthn', 'handlers.mjs')).href)).default;

// --- minimal CBOR writer (unsigned/negative ints, bytes, text, arrays, maps with int or text keys) ---
const head = (mt: number, n: number): Buffer => n < 24 ? Buffer.from([(mt << 5) | n]) : n < 256 ? Buffer.from([(mt << 5) | 24, n]) : n < 65536 ? Buffer.from([(mt << 5) | 25, n >> 8, n & 255]) : Buffer.from([(mt << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const cbor: (v: unknown) => Buffer = (v): Buffer => {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), Buffer.from(v as Uint8Array)]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v && typeof v === 'object') {
    const ks = Object.keys(v as Record<string, unknown>);
    return Buffer.concat([head(5, ks.length), ...ks.flatMap((k) => [cbor(/^-?\d+$/.test(k) ? Number(k) : k), cbor((v as Record<string, unknown>)[k])])]);
  }
  throw new Error('cbor: unsupported value');
};

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const RP = 'idp.test', ORIGIN = 'https://idp.test';

/** One software authenticator: an EC P-256 key pair and a credential id. */
function authenticator(credId = randomBytes(32)) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return { credId, privateKey, x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') };
}
const rpHash = (rp: string) => createHash('sha256').update(rp).digest();
const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
const authData = (rp: string, flags: number, counter: number, extra = Buffer.alloc(0)) => Buffer.concat([rpHash(rp), Buffer.from([flags]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(counter); return b; })(), extra]);

/** fmt 'none' attestation (UP + AT flags; the COSE key carries the credential public key). */
function attestationObject(a: ReturnType<typeof authenticator>, rp = RP) {
  const cose = cbor({ 1: 2, 3: -7, '-1': 1, '-2': a.x, '-3': a.y });
  const len = Buffer.alloc(2); len.writeUInt16BE(a.credId.length);
  const ad = authData(rp, 0x41, 0, Buffer.concat([Buffer.alloc(16), len, a.credId, cose]));
  return cbor({ fmt: 'none', attStmt: {}, authData: ad });
}
function registrationResponse(a: ReturnType<typeof authenticator>, challenge: string, origin = ORIGIN, rp = RP) {
  return {
    id: b64u(a.credId), rawId: b64u(a.credId), type: 'public-key',
    response: { clientDataJSON: b64u(clientData('webauthn.create', challenge, origin)), attestationObject: b64u(attestationObject(a, rp)), transports: ['internal'] },
    clientExtensionResults: {},
  };
}
function assertionResponse(a: ReturnType<typeof authenticator>, challenge: string, counter: number, opts: { origin?: string; rp?: string; signWith?: ReturnType<typeof authenticator> } = {}) {
  const cd = clientData('webauthn.get', challenge, opts.origin ?? ORIGIN);
  const ad = authData(opts.rp ?? RP, 0x01, counter);
  const sig = cryptoSign('sha256', Buffer.concat([ad, createHash('sha256').update(cd).digest()]), (opts.signWith ?? a).privateKey);
  return {
    id: b64u(a.credId), rawId: b64u(a.credId), type: 'public-key',
    response: { authenticatorData: b64u(ad), clientDataJSON: b64u(cd), signature: b64u(sig), userHandle: null },
    clientExtensionResults: {},
  };
}

const CONFIG = { rpName: 'Test RP', originMode: 'host', userVerification: 'preferred', residentKey: 'preferred', attestation: 'none', timeoutSeconds: 60 };

/** Enrolls one authenticator through the plugin's own ceremony (options then attestation check). */
async function enroll(a: ReturnType<typeof authenticator>, config: Record<string, unknown> = CONFIG) {
  const o = await handlers['auth.enroll']({ mode: 'options', tenant: 't', subject: 'u1', config, origin: ORIGIN, now: Date.now(), existing: [] }, {});
  assert.equal(o.ok, true);
  const v = await handlers['auth.enroll']({ mode: 'verify', tenant: 't', subject: 'u1', config, challenge: o.challenge, origin: o.origin, rpId: o.rpId, credential: registrationResponse(a, o.challenge), now: Date.now() }, {});
  assert.equal(v.ok, true, v.reason);
  return v.record;
}
const asEnrollment = (record: { id: string; publicKey: string; counter: number; transports?: string[] }) => ({ webauthn: { credentials: [{ id: record.id, publicKey: record.publicKey, counter: record.counter, transports: record.transports }] } });

test('passkey enrollment ceremony: options then attestation check produce the stored record', async () => {
  const a = authenticator();
  const record = await enroll(a);
  assert.equal(record.id, b64u(a.credId));
  assert.equal(typeof record.publicKey, 'string');
  assert.equal(record.counter, 0);
});

test('enrollment refuses a wrong origin and a tampered challenge', async () => {
  const a = authenticator();
  const o = await handlers['auth.enroll']({ mode: 'options', tenant: 't', subject: 'u1', config: CONFIG, origin: ORIGIN, now: Date.now(), existing: [] }, {});
  const wrongOrigin = await handlers['auth.enroll']({ mode: 'verify', tenant: 't', subject: 'u1', config: CONFIG, challenge: o.challenge, origin: ORIGIN, rpId: o.rpId, credential: registrationResponse(a, o.challenge, 'https://evil.test'), now: Date.now() }, {});
  assert.equal(wrongOrigin.ok, false);
  const wrongChallenge = await handlers['auth.enroll']({ mode: 'verify', tenant: 't', subject: 'u1', config: CONFIG, challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', origin: ORIGIN, rpId: o.rpId, credential: registrationResponse(a, o.challenge), now: Date.now() }, {});
  assert.equal(wrongChallenge.ok, false);
});

test('fixed mode pins the RP id and refuses an origin outside the list', async () => {
  const fixed = { ...CONFIG, originMode: 'fixed', rpId: 'example.com', origins: 'https://app.example.com, https://admin.example.com' };
  const o = await handlers['auth.enroll']({ mode: 'options', tenant: 't', subject: 'u1', config: fixed, origin: 'https://app.example.com', now: Date.now(), existing: [] }, {});
  assert.equal(o.ok, true); assert.equal(o.rpId, 'example.com');
  const refused = await handlers['auth.enroll']({ mode: 'options', tenant: 't', subject: 'u1', config: fixed, origin: 'https://evil.example.com', now: Date.now(), existing: [] }, {});
  assert.equal(refused.ok, false);
});

test('sign-in ceremony: prepare builds request options, verify accepts the real signature and spends the challenge', async () => {
  const a = authenticator();
  const record = await enroll(a);
  const prep = await handlers['auth.prepare']({ tenant: 't', subject: 'u1', known: true, instanceId: 'passkey', config: CONFIG, origin: ORIGIN, state: {}, now: Date.now(), enrollment: asEnrollment(record) }, {});
  assert.equal(prep.prompt.fields[0].type, 'webauthn');
  assert.equal(prep.prompt.fields[0].options.rpId, RP);
  assert.deepEqual(prep.prompt.fields[0].options.allowCredentials.map((c: { id: string }) => c.id), [record.id]);
  const payload = { tenant: 't', subject: 'u1', known: true, instanceId: 'passkey', config: CONFIG, origin: ORIGIN, enrollment: asEnrollment(record) };
  const ok = await handlers['auth.verify']({ ...payload, state: prep.state, answers: { webauthn: JSON.stringify(assertionResponse(a, prep.state.challenge, 1)) }, now: Date.now() }, {});
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.credentialCounter, { id: record.id, counter: 1 });
  const replay = await handlers['auth.verify']({ ...payload, state: ok.state, answers: { webauthn: JSON.stringify(assertionResponse(a, prep.state.challenge, 2)) }, now: Date.now() }, {});
  assert.equal(replay.ok, false, 'a spent challenge can never verify again');
});

test('sign-in refuses: another rpId, another key, an unknown credential, an expired challenge, an unknown user', async () => {
  const a = authenticator(), b = authenticator();
  const record = await enroll(a);
  const prep = await handlers['auth.prepare']({ tenant: 't', subject: 'u1', known: true, instanceId: 'passkey', config: CONFIG, origin: ORIGIN, state: {}, now: Date.now(), enrollment: asEnrollment(record) }, {});
  const base = { tenant: 't', subject: 'u1', known: true, instanceId: 'passkey', config: CONFIG, origin: ORIGIN, state: prep.state, enrollment: asEnrollment(record), now: Date.now() };
  const attempt = (r: unknown, over: Record<string, unknown> = {}) => handlers['auth.verify']({ ...base, ...over, answers: { webauthn: JSON.stringify(r) } }, {});
  assert.equal((await attempt(assertionResponse(a, prep.state.challenge, 1, { rp: 'other.test' }))).ok, false, 'rpId hash mismatch');
  assert.equal((await attempt(assertionResponse(a, prep.state.challenge, 1, { signWith: b }))).ok, false, 'signature from another key');
  assert.equal((await attempt(assertionResponse(b, prep.state.challenge, 1))).ok, false, 'credential never enrolled');
  assert.equal((await attempt(assertionResponse(a, prep.state.challenge, 1), { state: { ...prep.state, exp: 1 }, now: Date.now() })).ok, false, 'expired challenge');
  assert.equal((await attempt(assertionResponse(a, prep.state.challenge, 1), { known: false })).ok, false, 'unknown user');
  assert.equal((await attempt({ garbage: true })).ok, false, 'malformed answer');
});

test('verification note is real and descriptive', () => {
  const v = handlers['auth.verification']({ config: CONFIG }, {});
  assert.equal(v.real, true);
});

test('enrollment store: passkey records, pending challenge and the atomic anti-clone counter', async () => {
  const s = new EnrollmentStore(join(mkdtempSync(join(tmpdir(), 'iam-wa-')), 'e.json'));
  const a = authenticator();
  const record = await enroll(a);
  await s.setWebAuthnPending('t', 'u', 'i', { challenge: 'c', origin: ORIGIN, rpId: RP, exp: Date.now() + 1000 });
  assert.equal((await s.webAuthnPending('t', 'u', 'i'))?.challenge, 'c');
  assert.equal(await s.addWebAuthnCredential('t', 'u', 'i', { ...record, createdAt: 'now' }), true);
  assert.equal(await s.webAuthnPending('t', 'u', 'i'), undefined, 'enrolling spends the pending challenge');
  assert.equal((await s.webauthnRecord('t', 'u', 'i'))?.credentials.length, 1);
  assert.equal(await s.addWebAuthnCredential('t', 'u', 'i', { ...record, publicKey: 'AAAAAAAA', createdAt: 'now' }), false, 'same id, other key: refused');
  assert.equal(await s.advanceWebAuthnCounter('t', 'u', 'i', record.id, 3), true);
  assert.equal(await s.advanceWebAuthnCounter('t', 'u', 'i', record.id, 3), false, 'same counter again: replay');
  assert.equal(await s.advanceWebAuthnCounter('t', 'u', 'i', record.id, 2), false, 'regressed counter: cloned authenticator');
  assert.equal(await s.advanceWebAuthnCounter('t', 'u', 'i', record.id, 0), true, 'counter 0 carries no signal');
  const st = await s.status('t', 'u');
  assert.equal((st.i.webauthn as unknown[]).length, 1);
  assert.equal(await s.removeWebAuthnCredential('t', 'u', 'i', record.id), true);
  assert.equal(await s.webauthnRecord('t', 'u', 'i'), undefined);
});
