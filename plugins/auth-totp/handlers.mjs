import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = ALPHABET.indexOf(ch); if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(key, counter, digits) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(off) & 0x7fffffff) % 10 ** digits)).padStart(digits, '0');
}
function totpVerify(secret, code, now, period, digits, window) {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const key = base32Decode(secret), step = Math.floor(now / 1000 / period);
  let hit = null; // no early exit: constant work for any code
  for (let d = -window; d <= window; d++) if (hotp(key, step + d, digits) === code && hit === null) hit = step + d;
  return hit;
}

export default {
  'auth.verification': () => ({ real: true, note: 'Verified against a per-user enrolled secret (demo: provisioned by an administrator and shown once; a real product enrolls from the user\'s own session).' }),
  'auth.prepare': (p) => { const d = Number(p.config.digits ?? 6); return { prompt: { title: 'Authenticator code', fields: [{ name: 'code', label: 'Code from your app', type: 'digits', maxLength: d, hint: `${d} digits` }] }, state: {} }; },
  'auth.verify': async (p, c) => {
    const a = p.answers ?? {};
    if (!p.known || typeof a.code !== 'string') return false;
    const rec = await c.enroll.totp(c.tenant, p.subject, p.instanceId); if (!rec) return false;
    const step = totpVerify(rec.secret, a.code.trim(), c.now(), Number(p.config.periodSeconds ?? 30), Number(p.config.digits ?? 6), Number(p.config.window ?? 1));
    return step !== null && (await c.enroll.consumeTotpStep(c.tenant, p.subject, p.instanceId, step));
  },
};
