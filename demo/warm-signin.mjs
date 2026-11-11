// Hosted-demo startup readiness. No credential, token exchange or user login is involved.
// Run before the edge starts: a healthy NestJS process is not proof that the auth plugin bus answers.
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export async function warmSignin({ apiOrigin = 'http://127.0.0.1:3000', coreOrigin = 'http://127.0.0.1:8081', publicOrigin, fetchFn = fetch, attempts = 3, retryDelayMs = 2000, timeoutMs = 60000, log = console.log }) {
  if (!publicOrigin) throw new Error('publicOrigin is required');
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Direct API requests do not have the edge's /api prefix. The old warm-up always got 404.
      const options = await fetchFn(`${apiOrigin}/tenants/acme-demo/signin/options`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!options.ok) throw new Error(`options HTTP ${options.status}`);
      const body = await options.json();
      if (body.mode !== 'choice' || !body.chains?.some((c) => c.id === 'password-only')) throw new Error('seeded password-only chain is not offered');
      // Exercise core -> gate -> auth.prepare over the real bus, not just the cached methods list.
      const query = new URLSearchParams({ client_id: 'demo-web', redirect_uri: `${publicOrigin.replace(/\/$/, '')}/callback`, response_type: 'code', state: 'startup-readiness', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256', chain: 'password-only' });
      const entry = await fetchFn(`${coreOrigin}/authorize?${query}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      if (!entry.ok) throw new Error(`gate entry HTTP ${entry.status}`);
      const html = await entry.text();
      if (!/name="username"/.test(html) || !/name="password"/.test(html)) throw new Error('gate entry did not render the password form');
      log('[demo] sign-in readiness: options and gate entry ready');
      return;
    } catch (e) {
      last = e;
      // Never log a response body or request headers. Only our bounded status/error descriptions.
      log(`[demo] sign-in readiness attempt ${attempt}/${attempts} failed: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  throw new Error(`sign-in readiness failed after ${attempts} attempts`, { cause: last });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await warmSignin({ publicOrigin: process.env.PUBLIC_ORIGIN }); }
  catch { console.error('[demo] FATAL: sign-in gate never became ready; edge will not start'); process.exitCode = 1; }
}
