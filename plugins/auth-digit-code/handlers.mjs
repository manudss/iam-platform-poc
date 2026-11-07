import { randomInt, randomBytes } from 'node:crypto';

const PHONE_LETTERS = { '0': '', '1': '', '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };
/** A new random order and new opaque button ids on every page: an id only means something on the page that carried it. */
function keypadPrompt(config, entered, error) {
  const digits = '0123456789'.split('');
  for (let i = digits.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [digits[j], digits[i]] = [digits[j], digits[i]]; }
  const len = Number(config.length ?? 6), map = {};
  const keys = digits.map((d) => { const id = randomBytes(9).toString('base64url'); map[id] = d; return { id, digit: d, letters: PHONE_LETTERS[d] }; });
  return { map, prompt: { title: 'PIN', message: error ?? `Enter your ${len}-digit PIN with the on-screen buttons. Their order changes every time.`, fields: [{ name: 'key', label: 'PIN', type: 'keypad', keys, entered: entered.length, length: len }] } };
}

export default {
  'auth.verification': () => ({ real: true, note: 'Verified against a salted scrypt hash of the whole enrolled PIN (knowledge factor). Keypad ids are single page and bound to the sign-in session.' }),
  'auth.prepare': (p) => { const k = keypadPrompt(p.config, []); return { prompt: k.prompt, state: { entered: [], map: k.map, presses: 0 } }; },
  'auth.interact': async (p, c) => {
    const st = p.state ?? {}, a = p.answers ?? {}, entered = [...(st.entered ?? [])];
    const len = Number(p.config.length ?? 6);
    if (++st.presses > 40) return { done: true, ok: false };
    if (typeof a.key === 'string') {
      const d = st.map?.[a.key];
      if (d === undefined) return { done: true, ok: false };            // an id that this page never carried: a replayed or forged button
      if (entered.length < len) entered.push(d);
    } else if (a.action === 'delete') { entered.pop(); }
    else if (a.action === 'submit') {
      if (entered.length !== len) return { done: true, ok: false };
      return { done: true, ok: p.known && (await c.enroll.verifyPinFull(c.tenant, p.subject, p.instanceId, entered.join(''))) };
    } else return { done: true, ok: false };
    const k = keypadPrompt(p.config, entered);
    return { done: false, prompt: k.prompt, state: { entered, map: k.map, presses: st.presses } };
  },
};
