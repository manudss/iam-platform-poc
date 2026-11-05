import { generateKeyPairSync, sign as signDigest, KeyObject } from 'node:crypto';

/**
 * Minimal self-signed X.509 certificate for the SAML demo IdP (RSA-2048, SHA-256), built without any
 * external tool so the free demo container (no openssl binary) can sign at boot. DEMO ONLY: a real
 * deployment reads the key from the secret store (`sso/<tenant>/saml-signing-key`) instead.
 */

const tlv = (tag: number, content: Buffer): Buffer => {
  const n = content.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
};
const seq = (...c: Buffer[]) => tlv(0x30, Buffer.concat(c));
const set = (...c: Buffer[]) => tlv(0x31, Buffer.concat(c));
const oid = (nums: number[]) => {
  const out = [40 * nums[0] + nums[1]];
  for (const n of nums.slice(2)) { const bytes = [n & 127]; let r = n >> 7; while (r) { bytes.unshift((r & 127) | 128); r >>= 7; } out.push(...bytes); }
  return tlv(0x06, Buffer.from(out));
};
const int = (n: number | Buffer) => {
  let b = Buffer.isBuffer(n) ? n : Buffer.from([n]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const bitstr = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const octstr = (b: Buffer) => tlv(0x04, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const ctx = (n: number, c: Buffer) => tlv(0xa0 + n, c);
const utctime = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const SHA256_RSA = seq(oid([1, 2, 840, 113549, 1, 1, 11]), tlv(0x05, Buffer.alloc(0)));
const name = (cn: string) => seq(set(seq(oid([2, 5, 4, 3]), utf8(cn))));

/** Generates { privateKeyPem, certPem }: a fresh RSA-2048 key and a self-signed certificate valid 10 years. */
export function selfSignedCert(cn: string): { privateKeyPem: string; certPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' });
  const now = new Date(), later = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);
  const serial = Buffer.alloc(16); serial[0] = 1; serial[15] = 1;
  const basicConstraints = seq(oid([2, 5, 29, 19]), bool(true), octstr(seq()));
  const keyUsage = seq(oid([2, 5, 29, 15]), bool(true), octstr(bitstr(Buffer.from([0xa0]), 5))); // digitalSignature + keyEncipherment
  const tbs = seq(
    ctx(0, int(2)), int(serial), SHA256_RSA, name(cn),
    seq(utctime(now), utctime(later)), name(cn), spki,
    ctx(3, seq(basicConstraints, keyUsage)),
  );
  const signature = signDigest('sha256', tbs, privateKey as KeyObject);
  const cert = seq(tbs, SHA256_RSA, bitstr(signature));
  const pem = (b: Buffer, label: string) => `-----BEGIN ${label}-----\n${b.toString('base64').replace(/.{64}/g, '$&\n')}\n-----END ${label}-----\n`;
  return { privateKeyPem: (privateKey as KeyObject).export({ format: 'pem', type: 'pkcs8' }) as string, certPem: pem(cert, 'CERTIFICATE') };
}
