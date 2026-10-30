import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (the format authenticator apps expect). */
export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function newTotpSecret(): string { return base32Encode(randomBytes(20)); }

/** RFC 4226 HOTP with HMAC-SHA1 (the algorithm every authenticator app supports). */
export function hotp(secret: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
export function totpAt(secretB32: string, nowMs: number, period: number, digits: number): string {
  return hotp(base32Decode(secretB32), Math.floor(nowMs / 1000 / period), digits);
}
/** Returns the matching time step (so the caller can refuse a replay of the same step) or null. Window = accepted steps either side. */
export function totpVerify(secretB32: string, code: string, nowMs: number, period: number, digits: number, window: number): number | null {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const key = base32Decode(secretB32), step = Math.floor(nowMs / 1000 / period);
  let hit: number | null = null; // no early exit: constant work for any code
  for (let d = -window; d <= window; d++) if (hotp(key, step + d, digits) === code && hit === null) hit = step + d;
  return hit;
}
export function otpauthUri(issuer: string, account: string, secretB32: string, period: number, digits: number) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${period}`;
}
