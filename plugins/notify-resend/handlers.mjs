import { createRequire } from 'node:module';
// Step 4: the plugin declares its own dependency in its package.json and resolves it from the
// controlled shared install at the repo root (scripts/plugin-deps.mjs).
const { Resend } = createRequire(new URL('./package.json', import.meta.url))('resend');

/**
 * notify.send over the Resend HTTPS API. The key comes from the RESEND_API_KEY environment variable only
 * (never from settings, never in code or in the data branches). Without it the plugin degrades to the base
 * log transport, so development keeps working with simulated delivery.
 */
const key = () => process.env.RESEND_API_KEY;

export default {
  'notify.send': async (p, c) => {
    if (!key()) {
      // Explicit unavailability policy (P1-E): no key = no real delivery. The base log transport still records the
      // message (development keeps working, simulated), and the result SAYS it was degraded instead of pretending.
      const base = c.base?.['notify.send'] ? c.base['notify.send'](p, c) : { delivered: false, real: false, line: `notify: ${p.template} -> ${p.to}` };
      return { ...base, delivered: false, real: false, degraded: 'RESEND_API_KEY not set on the server' };
    }
    const from = c.settings.from || 'lyam@dss.name';
    // Rendered content (subject/text/html) is attached by the core after a notify.render call on the
    // notify.templates slot (mail-templates). The legacy raw dump stays for payloads without it.
    const subject = typeof p.subject === 'string' && p.subject ? p.subject : `[iam] ${p.template}`;
    const text = typeof p.text === 'string' && p.text ? p.text : `${p.template}\n\n${Object.entries(p.data ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}`;
    const html = typeof p.html === 'string' && p.html ? p.html : undefined;
    const r = await new Resend(key()).emails.send({ from, to: p.to, subject, text, ...(html ? { html } : {}) });
    if (r.error) throw new Error(`resend delivery failed: ${r.error.message}`);
    return { delivered: true, real: true, id: r.data?.id ?? null };
  },
  // The OTP flow asks the slot before promising a real e-mail (P1-E: the send path is chosen by the slot).
  'notify.capability': () => key()
    ? { real: true, note: 'real delivery through the Resend HTTPS API' }
    : { real: false, note: 'RESEND_API_KEY not set on the server: delivery is simulated (log transport)' },
};
