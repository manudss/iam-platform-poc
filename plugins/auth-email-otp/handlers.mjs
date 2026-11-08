import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * One-time code by e-mail. The SEND PATH IS THE notify.default SLOT (P1-E): the notifier plugin chosen on the slot
 * (notify-resend, or any replacement) delivers; the base log transport simulates. No core mail adapter anymore.
 * The slot's notify.capability answer decides whether the page promises a real e-mail (explicit unavailability policy).
 * Bus-safe contract (step 2): profile address, enrolled address, live notify capability and the clock come IN THE
 * PAYLOAD (read core-side); the actual sends are returned as EFFECTS (notify / mail) the core applies.
 */
export default {
  'auth.verification': (p) => p.config.delivery === 'smtp'
    ? { real: true, note: 'Code delivered by e-mail through the active notify.default plugin, when that plugin really delivers (the shipped notify-resend needs RESEND_API_KEY on the server): checked live at every sign-in.' }
    : { real: false, note: 'SIMULATED: the code is written to a demo outbox that administrators can read, so it does not prove possession of a mailbox.' },
  'auth.prepare': (p) => {
    const len = Number(p.config.codeLength ?? 6), ttl = Number(p.config.ttlSeconds ?? 300);
    const code = String(randomInt(0, 10 ** len)).padStart(len, '0');
    const wantsReal = p.config.delivery === 'smtp';
    const now = Number(p.now ?? Date.now());
    // The profile address first, the demo enrollment address as a fallback. Unknown accounts get the same page and no message.
    const to = p.known ? (p.profileEmail ?? p.enrollment?.email ?? `${p.subject}@mail.example.invalid`) : '';
    const text = `Your sign-in code is ${code}. It expires in ${Math.round(ttl / 60)} minute(s). If you did not try to sign in, ignore this message.`;
    const notify = p.known && wantsReal && p.notifyCapability?.real
      ? { tenant: p.tenant, to, template: 'sign-in-code', data: { code, ttlMinutes: Math.round(ttl / 60), subjectUser: p.subject }, effectKey: `otp:${sha(`${p.instanceId}:${code}`).slice(0, 32)}` }
      : undefined;
    const mail = p.known && !notify ? { tenant: p.tenant, to, subject: 'Your sign-in code', text, subjectUser: p.subject, template: 'sign-in-code', data: { code, ttlMinutes: Math.round(ttl / 60), subjectUser: p.subject } } : undefined;
    const real = !!notify;
    return { prompt: { title: 'Check your e-mail', message: real ? 'If the account exists, a code was sent to its e-mail address.' : 'DEMO ONLY: no e-mail is sent. In this prototype the code is written to a demo outbox that an administrator can read.', fields: [{ name: 'code', label: 'Code', type: 'digits', maxLength: len, hint: `${len} digits` }] },
      state: { hash: sha(`${p.instanceId}:${code}`), exp: now + ttl * 1000, used: false }, ...(notify ? { notify } : {}), ...(mail ? { mail } : {}) };
  },
  'auth.verify': (p) => {
    const st = p.state ?? {}, answers = p.answers ?? {}, now = Number(p.now ?? Date.now());
    if (!p.known || st.used || now > st.exp || typeof answers.code !== 'string') return { ok: false };
    const ok = eq(sha(`${p.instanceId}:${answers.code.trim()}`), st.hash);
    return { ok, state: ok ? { ...st, used: true } : undefined };
  },
};
