/** RFC 6238 TOTP (HMAC-SHA-1), no dependency. The secret is enrolled per user. The window accepts the steps
 * around the current one (clock drift); a step ALREADY CONSUMED can never be accepted again (anti-replay). */
import { createHmac } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32decode = (s) => {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('invalid base32 secret');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
};
const hotp = (secret, step, digits) => {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
};
export const totpCode = (b32, step, digits = 6) => String(hotp(b32decode(b32), step, digits)).padStart(digits, '0');

export default {
  'auth.verification': () => ({ real: true, note: 'The code is checked against the enrolled secret, not simulated.' }),
  'auth.prepare': (p) => {
    const digits = Number(p.config.digits ?? 6);
    return { prompt: { title: 'Authenticator code', message: 'Enter the code shown by your authenticator app.', fields: [{ name: 'code', label: 'Code', type: 'digits', maxLength: digits, hint: `${digits} digits` }] }, state: {} };
  },
  // Bus-safe contract (step 2): the enrollment record and the clock come IN THE PAYLOAD (read core-side); the
  // anti-replay step consumption is returned as an effect the core applies atomically after an ok.
  'auth.verify': (p) => {
    const t = p.enrollment?.totp;
    if (!p.known || !t || typeof p.answers?.code !== 'string') return { ok: false };
    const now = Number(p.now ?? Date.now());
    const digits = Number(p.config.digits ?? 6), period = Number(p.config.periodSeconds ?? 30), win = Number(p.config.window ?? 1);
    const code = p.answers.code.trim();
    for (let w = -win; w <= win; w++) {
      const step = Math.floor(now / 1000 / period) + w;
      if (step <= (t.lastStep ?? -1)) continue;
      if (totpCode(t.secret, step, digits) === code) return { ok: true, consumeStep: step };
    }
    return { ok: false };
  },
};
