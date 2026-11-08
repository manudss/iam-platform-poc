#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Deploys the standing PRODUCTION demo service (iam-poc: iam-poc-demo.onrender.com
// + the lyam.dss.name custom domain) after the "Demo image (GHCR)" workflow built a
// push to main. Render only PULLS the freshly pushed image: zero build pipeline
// minutes (see docs/pr-previews.md).
//
// SAFETY GATE: this script never starts a Docker build on Render. It first reads
// the service and refuses to deploy while it is still git-backed (a deploy then
// would build from source and spend the workspace's 500 free build minutes/month).
// The one-time git-backed -> image-backed switch is a MANUAL step (documented in
// docs/pr-previews.md, decided by the repo owner); until it is done this script
// exits 0 with a clear "skipped" message.
//
// What it does when the service IS image-backed:
//   1. POST /services/{id}/deploys (Render pulls the current ghcr image tag the
//      service points at - ghcr.io/manudss/iam-platform-poc:latest after the
//      migration; every push to main rebuilds that tag).
//   2. Watches the deploy to a final status; non-zero exit on failure/timeout so
//      the Actions run goes red instead of hiding a broken demo.
// No secret is ever printed or written anywhere: RENDER_API_KEY stays in the
// GitHub secret, the service's own env vars (RESEND_API_KEY, ...) are never read.
// Usage: node scripts/render-prod-deploy.mjs
// Env: RENDER_API_KEY, PROD_SERVICE_NAME (default iam-poc),
//      PROD_POLL_MS / PROD_WAIT_MAX_MS (watch tuning), DRY_RUN=1 to print the plan.
const e = process.env;
const DRY = e.DRY_RUN === '1';
if (!DRY && !e.RENDER_API_KEY) throw new Error('RENDER_API_KEY missing');

const RENDER = 'https://api.render.com/v1';
const SVC_NAME = e.PROD_SERVICE_NAME ?? 'iam-poc';
const POLL_MS = Number(e.PROD_POLL_MS ?? 20000);
const WAIT_MAX_MS = Number(e.PROD_WAIT_MAX_MS ?? 15 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Deploy statuses that end a watch (same semantics as the previews script).
const FINAL_DEPLOY = new Set(['live', 'build_failed', 'update_failed', 'canceled', 'deactivated']);

async function render(method, path, body) {
  if (DRY) { console.log('[dry]', method, path, body ? JSON.stringify(body) : ''); return {}; }
  const res = await fetch(RENDER + path, {
    method,
    headers: { Authorization: `Bearer ${e.RENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
async function findService(svcName) {
  if (DRY) return { id: 'srv-dry', name: svcName, serviceDetails: { runtime: 'image' } };
  const list = await render('GET', `/services?name=${encodeURIComponent(svcName)}&limit=5`);
  const hit = (Array.isArray(list) ? list : []).map((x) => x.service ?? x).find((s) => s.name === svcName);
  return hit ?? null;
}
async function latestDeploy(svcId) {
  const list = await render('GET', `/services/${svcId}/deploys?limit=1`);
  return (Array.isArray(list) ? list : []).map((x) => x.deploy ?? x)[0] ?? null;
}
function isImageBacked(s) {
  const details = s?.serviceDetails ?? {};
  return details.runtime === 'image' || Boolean(s?.image?.imagePath);
}

// Deploys and watches. Returns { deployed, reason } ; throws on a FAILED deploy or
// a watch timeout (the Actions run must go red), never on the git-backed skip.
async function run() {
  const s = await findService(SVC_NAME);
  if (!s) throw new Error(`service ${SVC_NAME} introuvable sur Render`);
  if (!isImageBacked(s)) {
    console.log(`skipped: ${SVC_NAME} est encore git-backed - bascule image manuelle d'abord (docs/pr-previews.md). Aucun deploy lance, aucun build Render consomme.`);
    return { deployed: false, reason: 'git-backed' };
  }
  const since = Date.now();
  const res = await render('POST', `/services/${s.id}/deploys`, {});
  const dep = res?.deploy ?? res;
  console.log(`deploy ${dep?.id ?? '(dry)'} lance sur ${SVC_NAME} (${s.id}) : Render telecharge l'image GHCR, aucun build.`);
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    if (DRY) return { deployed: true, reason: 'dry' };
    const d = await latestDeploy(s.id);
    if (d && FINAL_DEPLOY.has(d.status) && new Date(d.createdAt ?? 0).getTime() >= since - 60000) {
      if (d.status === 'live') { console.log(`deploy ${d.id} live.`); return { deployed: true, reason: 'live' }; }
      throw new Error(`deploy ${d.id} a echoue (statut ${d.status}) - voir le dashboard Render, rollback possible via le deploy precedent.`);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`deploy toujours en cours apres ~${Math.round(WAIT_MAX_MS / 60000)} min : Render continue, verifier le dashboard.`);
}

export { run, isImageBacked, findService };

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await run();
