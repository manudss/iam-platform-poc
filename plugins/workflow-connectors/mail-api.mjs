import { createRequire } from 'node:module';
const require = createRequire(new URL('./package.json', import.meta.url));

/**
 * One mail through the Resend HTTPS API, with the provider's idempotency key (the same key and payload within
 * 24 hours returns the first response and sends nothing again). The key comes only from RESEND_API_KEY on the
 * server. Result: the provider's message id, which proves ACCEPTANCE by Resend, not delivery to the inbox.
 * Throws a message without credentials. `client` is a test seam.
 */
export const mailClient = { Ctor: null };
export async function sendOneMail({ apiKey, from, to, subject, text, idempotencyKey }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set on the server');
  if (!idempotencyKey || idempotencyKey.length > 256) throw new Error('idempotency key required (1 to 256 characters)');
  const Ctor = mailClient.Ctor ?? require('resend').Resend;
  let r;
  try { r = await new Ctor(apiKey).emails.send({ from, to, subject, text }, { idempotencyKey }); }
  catch { throw new Error('mail provider unreachable: outcome unknown, reconcile before any new send'); }
  if (r?.error) throw new Error(`mail provider refused (${String(r.error.name ?? 'error')})`);
  const id = r?.data?.id;
  if (typeof id !== 'string' || !id) throw new Error('mail provider gave no message id: outcome unknown, reconcile before any new send');
  return { id };
}
