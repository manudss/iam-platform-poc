import { createRequire } from 'node:module';
// The SDK is an apps/api dependency: resolve it from there (plugin folders have no node_modules of their own).
const { Resend } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('resend');

/**
 * notify.send over the Resend HTTPS API. The key comes from the RESEND_API_KEY environment variable only
 * (never from settings, never in code or in the data branches). Without it the plugin degrades to the base
 * log transport, so development keeps working with simulated delivery.
 */
export default {
  'notify.send': async (p, c) => {
    const key = process.env.RESEND_API_KEY;
    if (!key) return c.base?.['notify.send'] ? c.base['notify.send'](p, c) : { delivered: false, line: `notify: ${p.template} -> ${p.to}` };
    const from = c.settings.from || 'lyam@dss.name';
    const text = `${p.template}\n\n${Object.entries(p.data ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}`;
    const r = await new Resend(key).emails.send({ from, to: p.to, subject: `[iam] ${p.template}`, text });
    if (r.error) throw new Error(`resend delivery failed: ${r.error.message}`);
    return { delivered: true, id: r.data?.id ?? null };
  },
};
