#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Orchestrates the per-PR Render preview service (one all-in-one demo container:
// Dolt + Rust core + NestJS API + Angular console) from a TRUSTED GitHub Actions
// workflow (pull_request_target, or issue_comment / workflow_dispatch which run
// the DEFAULT branch version: never PR code).
//
// PREBUILT IMAGES (since 2026-11-08): the Docker image is built on GitHub-hosted
// runners by .github/workflows/demo-image.yml and pushed to GHCR
// (ghcr.io/<owner>/<repo>:<commit sha>) - free and unlimited on this public repo.
// Render only PULLS and starts the image: a /preview demand no longer spends any
// of the workspace's 500 free build pipeline minutes/month on a ~10-20 min Render
// Docker build, it costs a ~1-3 min image pull + boot instead.
//
// DEPLOY ON DEMAND (unchanged principle): a push on a PR branch NEVER deploys.
//   - ensure   (PR opened / updated): no deploy, no service creation. Only maintains
//              the status comment on the PR. No URL is shown before the service has
//              a LIVE deploy (no dead/placeholder links on the PR).
//   - refresh  (`/preview` PR comment from OWNER/MEMBER/COLLABORATOR, or the manual
//              Actions dispatch): makes sure the GHCR image for the PR head exists
//              (waits for the demo-image workflow run, dispatches it as a last
//              resort), then creates the service if needed (image-backed),
//              recreates it if it is an old git-backed one, points it at the head
//              image tag, deploys, WAITS for the outcome and publishes the URLs in
//              the PR comment only once the preview is live (or a failure note
//              without links). The head branch/sha are read back from the GitHub
//              API here, never taken from event or env metadata.
//   - cleanup  (PR closed): deletes the service.
// Untrusted values (branch name) are validated before use. Infra secrets
// (RENDER_API_KEY) stay in the trusted workflow and never reach the preview service.
// Usage: node scripts/render-pr-previews.mjs ensure|refresh|cleanup
// Env: RENDER_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER,
//      RENDER_OWNER_ID + RENDER_ENVIRONMENT_ID (refresh only, service creation),
//      PREVIEW_POLL_MS / PREVIEW_WAIT_MAX_MS (deploy watch tuning),
//      IMAGE_POLL_MS / IMAGE_WAIT_MAX_MS (GitHub image-build watch tuning),
//      DEMO_IMAGE_WORKFLOW (default demo-image.yml), DRY_RUN=1 to print the plan only.
const MODE = process.argv[2];
const e = process.env;
const DRY = e.DRY_RUN === '1';
const pr = Number(e.PR_NUMBER);
if (!Number.isInteger(pr) || pr <= 0) throw new Error('PR_NUMBER invalid');
const repoFull = e.GITHUB_REPOSITORY ?? '';
if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull)) throw new Error('GITHUB_REPOSITORY invalid');
const repoSlug = repoFull.toLowerCase();

const RENDER = 'https://api.render.com/v1';
const name = `iam-pr${pr}`;
const MARK = '<!-- render-previews-iam -->';
const IMAGE_WORKFLOW = e.DEMO_IMAGE_WORKFLOW ?? 'demo-image.yml';
const POLL_MS = Number(e.PREVIEW_POLL_MS ?? 30000);
const WAIT_MAX_MS = Number(e.PREVIEW_WAIT_MAX_MS ?? 16 * 60 * 1000);
const IMAGE_POLL_MS = Number(e.IMAGE_POLL_MS ?? 30000);
const IMAGE_WAIT_MAX_MS = Number(e.IMAGE_WAIT_MAX_MS ?? 30 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Render deploy statuses that end a watch. Anything else (build_in_progress,
// update_in_progress, pre_deploy_in_progress, created, ...) means keep waiting.
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
  const list = await render('GET', `/services?name=${encodeURIComponent(svcName)}&limit=5`);
  const hit = (Array.isArray(list) ? list : []).map((x) => x.service ?? x).find((s) => s.name === svcName);
  return hit ?? null;
}
async function latestDeploy(svcId) {
  const list = await render('GET', `/services/${svcId}/deploys?limit=1`);
  return (Array.isArray(list) ? list : []).map((x) => x.deploy ?? x)[0] ?? null;
}
// Wait for the deploy started at/after `sinceMs` to reach a final status.
// Returns the deploy, or null on timeout (and immediately in DRY_RUN).
async function waitForDeploy(svcId, sinceMs) {
  if (DRY) return null;
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const d = await latestDeploy(svcId);
    if (d && FINAL_DEPLOY.has(d.status) && new Date(d.createdAt ?? 0).getTime() >= sinceMs - 60000) return d;
    await sleep(POLL_MS);
  }
  return null;
}
async function gh(method, path, body) {
  if (DRY || e.GH_DRY === '1') { console.log('[dry gh]', method, path); return []; }
  const res = await fetch(`https://api.github.com/repos/${repoFull}${path}`, {
    method,
    headers: { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GH ${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}
async function upsertComment(markdown) {
  const comments = await gh('GET', `/issues/${pr}/comments?per_page=100`);
  const mine = (comments ?? []).find((c) => c.body?.includes(MARK));
  const body = `${MARK}\n${markdown}`;
  if (mine) await gh('PATCH', `/issues/comments/${mine.id}`, { body });
  else await gh('POST', `/issues/${pr}/comments`, { body });
}
const urlOf = (s, fallback) => s?.serviceDetails?.url ?? fallback;

// --- GitHub image build watch -------------------------------------------------
// The image for a commit is built by the demo-image workflow (push / pull_request
// triggers). refresh only waits for it; dispatching is the backstop for commits
// whose build never ran (e.g. the trigger was skipped).

async function dispatchImageBuild(sha) {
  if (DRY) { console.log('[dry gh] dispatch image build for', sha); return true; }
  const res = await fetch(`https://api.github.com/repos/${repoFull}/actions/workflows/${IMAGE_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: sha }),
  });
  if (res.status === 404) return false; // workflow not on the default branch yet
  if (!res.ok) throw new Error(`GH POST dispatches -> ${res.status}`);
  return true;
}

async function imageRuns(sha, status) {
  const q = `/actions/workflows/${IMAGE_WORKFLOW}/runs?head_sha=${sha}&per_page=10${status ? `&status=${status}` : ''}`;
  const r = await gh('GET', q);
  return r?.workflow_runs ?? [];
}

// Wait until the demo-image workflow has successfully built+tagged the image for
// `sha`. Returns 'built' when the image is ready, 'failed' when the build run
// concluded in failure, 'timeout' when nothing concluded in time, and 'missing'
// when no run exists and the workflow cannot be dispatched yet (it must exist on
// the default branch, which is only true after the migration PR merges).
async function ensureImageBuilt(sha) {
  if (DRY) { console.log('[dry gh] ensure image built for', sha); return 'built'; }
  const done = (runs) => {
    const success = runs.find((r) => r.conclusion === 'success' && r.status === 'completed');
    if (success) return 'built';
    const failed = runs.find((r) => r.status === 'completed' && r.conclusion !== 'success');
    return failed && !runs.some((r) => r.status !== 'completed') ? 'failed' : null;
  };
  let runs = await imageRuns(sha, 'completed');
  let state = done(runs);
  if (state) return state;
  const pending = await imageRuns(sha);
  if (!pending.some((r) => r.status !== 'completed')) {
    // Nothing running for this sha: dispatch the build (works once the workflow
    // file is on the default branch).
    const dispatched = await dispatchImageBuild(sha);
    if (!dispatched) return 'missing';
    await sleep(Math.min(IMAGE_POLL_MS, 10000)); // give GitHub a moment to register the run
  }
  const deadline = Date.now() + IMAGE_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    runs = await imageRuns(sha, 'completed');
    state = done(runs);
    if (state) return state;
    await sleep(IMAGE_POLL_MS);
  }
  return 'timeout';
}

function intro() {
  return `### Preview Render pour la PR #${pr}`;
}
function links(url) {
  return [
    `| Composant | Lien |`, '|---|---|',
    `| Demo tout-en-un (console + API + core + Dolt) | ${url} |`,
    `| Sante | ${url}/healthz |`,
  ].join('\n');
}
const HOWTO = "Pour deployer ou mettre a jour la preview avec le dernier commit : commente `/preview` sur cette PR (ou onglet **Actions > PR Previews > Run workflow** avec le numero de la PR).";
const SLEEP_NOTE = 'Le service se met en veille apres 15 min sans trafic (le premier appel peut prendre ~1 min) ; il est supprime a la fermeture de la PR.';
const PREBUILT_NOTE = "L'image Docker est construite sur GitHub Actions (gratuit, repo public) et publiee sur GHCR : Render ne fait que la telecharger et la demarrer, sans depenser les minutes de build du plan gratuit.";

// ensure: PR opened/updated. Never deploys; only keeps the status comment accurate.
// Rule: no URL on the PR while no deploy is live (a placeholder link would be dead).
async function ensure() {
  const svc = await findService(name);
  const guess = `https://${name}.onrender.com`;
  if (!svc) {
    await upsertComment([
      intro(),
      '**Preview a la demande** : les pushes ne lancent jamais de deploiement.',
      '',
      HOWTO,
      '',
      PREBUILT_NOTE,
      '',
      "Une fois l'image GHCR du dernier commit construite et la preview en ligne, l'URL sera publiee ici automatiquement - aucun lien tant que rien n'est en ligne. Le service est supprime a la fermeture de la PR.",
    ].join('\n'));
    console.log('no preview service: status comment only, no deploy, no URL.');
    return;
  }
  const realUrl = urlOf(svc, guess);
  const d = await latestDeploy(svc.id);
  if (d?.status !== 'live') {
    await upsertComment([
      intro(),
      `Preview pas encore en ligne (dernier deploiement Render : \`${d?.status ?? 'aucun'}\`). Les liens seront publies ici des qu'elle sera prete.`,
      '',
      'Les pushes ne redeploient plus automatiquement. ' + HOWTO,
    ].join('\n'));
    console.log(`preview service exists but latest deploy is ${d?.status ?? 'missing'}: no URL shown.`);
    return;
  }
  await upsertComment([
    intro(),
    links(realUrl),
    '',
    'Les pushes ne redeploient plus automatiquement. ' + HOWTO,
    SLEEP_NOTE,
  ].join('\n'));
  console.log('preview live: status comment refreshed, no deploy.');
}

// refresh: explicit request to (re)deploy the latest commit of the PR branch from
// its PREBUILT GHCR image, then watch the deploy and publish the URLs once live.
async function refresh() {
  // Read the head back from the API: never trust event/env metadata for what gets deployed.
  const d = await gh('GET', `/pulls/${pr}`);
  if (!d || d.state !== 'open') throw new Error(`PR #${pr} is not open`);
  if (d.head?.repo?.full_name !== repoFull) throw new Error('fork PR: refused');
  const branch = d.head?.ref ?? '';
  const sha = d.head?.sha ?? '';
  if (!/^[\w./-]{1,200}$/.test(branch)) throw new Error('head branch rejected');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('head sha rejected');

  // The all-in-one demo image needs demo/Dockerfile in the PR branch; skip cleanly otherwise.
  const dockerfile = await gh('GET', `/contents/demo/Dockerfile?ref=${sha}`);
  if (!dockerfile) {
    await upsertComment([
      intro(),
      'Pas de preview : cette branche ne contient pas `demo/Dockerfile` (image Docker tout-en-un Dolt + core + API + console).',
      'Ajoute ce fichier sur la branche, puis commente `/preview`.',
    ].join('\n'));
    console.log('demo/Dockerfile absent from the PR branch: no preview deployed.');
    return;
  }

  // 1. The GHCR image for this exact commit must exist (built on GitHub, free).
  const imagePath = `ghcr.io/${repoSlug}:${sha}`;
  const img = await ensureImageBuilt(sha);
  if (img === 'failed') {
    await upsertComment([
      intro(),
      `Le build GitHub de l'image du commit \`${sha.slice(0, 7)}\` a echoue (workflow **Demo image (GHCR)**).`,
      'Corriger le Dockerfile ou le code, pousser, puis relancer `/preview`. Aucun deploiement Render lance.',
    ].join('\n'));
    console.log('image build failed: failure posted, no Render call.');
    return;
  }
  if (img === 'missing') {
    await upsertComment([
      intro(),
      `Image du commit \`${sha.slice(0, 7)}\` introuvable sur GHCR, et le workflow **Demo image (GHCR)** n'est pas encore sur la branche par defaut pour etre relance a la demande.`,
      "Une fois la migration de l'image prebuild fusionnee, ce message disparait. En attendant, pousser un commit (le workflow la construit) puis relancer `/preview`.",
    ].join('\n'));
    console.log('image missing and workflow not dispatchable yet: noted on the PR.');
    return;
  }
  if (img === 'timeout') {
    await upsertComment([
      intro(),
      `Le build GitHub de l'image du commit \`${sha.slice(0, 7)}\` n'a pas fini dans le temps imparti (~${Math.round(IMAGE_WAIT_MAX_MS / 60000)} min).`,
      'Le workflow continue cote GitHub ; relancer `/preview` dans quelques minutes pour deployer.',
    ].join('\n'));
    console.log('image build watch timed out: noted on the PR.');
    return;
  }

  if (!e.RENDER_ENVIRONMENT_ID) throw new Error('RENDER_ENVIRONMENT_ID is required (IAM POOC project, dev environment)');
  const guess = `https://${name}.onrender.com`;

  const started = Date.now();
  let svc = await findService(name);
  let created = false;
  let migrated = false;
  if (svc && svc.serviceDetails?.runtime !== 'image') {
    // Legacy git-backed preview: replace it with an image-backed one (the embedded
    // Dolt data is fictional and disposable, and the git build would spend the
    // workspace's build minutes).
    await render('DELETE', `/services/${svc.id}`);
    svc = null;
    migrated = true;
  }
  if (!svc) {
    const r = await render('POST', '/services', {
      ownerId: e.RENDER_OWNER_ID,
      environmentId: e.RENDER_ENVIRONMENT_ID,
      // autoDeploy 'no' ON PURPOSE: the workflow is the single deploy trigger
      // (an automatic deploy AND the explicit deploy call would race).
      autoDeploy: 'no',
      type: 'web_service', name,
      image: { ownerId: e.RENDER_OWNER_ID, imagePath },
      envVars: [{ key: 'IAM_PUBLIC_ORIGIN', value: guess }],
      serviceDetails: {
        runtime: 'image', plan: 'free', region: 'frankfurt', healthCheckPath: '/healthz',
      },
    });
    svc = r.service ?? r;
    created = true;
  }
  const realUrl = urlOf(svc, guess);

  // The public origin must be the real URL (a name collision can add a suffix).
  // Changing an env var makes Render redeploy by itself, so skip the explicit deploy in that case.
  let envRedeploy = false;
  let imageChanged = false;
  if (!created) {
    const vars = await render('GET', `/services/${svc.id}/env-vars`);
    const current = (Array.isArray(vars) ? vars : []).map((x) => x.envVar ?? x).find((v) => v.key === 'IAM_PUBLIC_ORIGIN');
    if (!current || current.value !== realUrl) {
      await render('PUT', `/services/${svc.id}/env-vars/IAM_PUBLIC_ORIGIN`, { value: realUrl });
      envRedeploy = true;
    }
    const currentImage = svc.image?.imagePath ?? svc.serviceDetails?.image?.imagePath ?? null;
    if (currentImage !== imagePath) {
      await render('PATCH', `/services/${svc.id}`, { image: { ownerId: e.RENDER_OWNER_ID, imagePath } });
      imageChanged = true;
    }
  }
  if (!created && !envRedeploy) {
    // Explicit demand: pull the (new) image tag and start it. No build happens here.
    await render('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
  }

  // 2. Acknowledge immediately, WITHOUT the URL: until the first deploy is live the
  //    link would be dead, so the PR never shows it.
  await upsertComment([
    intro(),
    `Preview demandee : deploiement de l'image prebuild du commit \`${sha.slice(0, 7)}\` (${imageChanged || created ? 'nouvelle image pointee' : 'meme image, redemarrage'}).`,
    '',
    "L'image a ete construite sur GitHub Actions et publiee sur GHCR : Render la telecharge et la demarre (compter ~1-3 min, premier reveil inclus) - aucune minute de build Render consommee. Les liens seront publies ici des que la preview sera en ligne.",
    migrated ? "Note : l'ancien service de preview git-builde a ete remplace par un service image." : '',
    SLEEP_NOTE,
  ].join('\n'));

  // 3. Watch the deploy, then publish the outcome.
  const dep = await waitForDeploy(svc.id, started);
  if (dep?.status === 'live') {
    await upsertComment([
      intro(),
      `**Preview en ligne** (commit \`${sha.slice(0, 7)}\`, image GHCR prebuild) :`,
      '',
      links(realUrl),
      '',
      'Un seul service Docker gratuit (plan Free, Frankfurt), deploye depuis `ghcr.io` (image construite par GitHub Actions, aucun build Render), dans le projet Render **IAM POOC** (environnement `dev`).',
      'Les donnees Dolt sont les seeds fictives embarquees dans le conteneur : elles sont propres a cette preview et disparaissent avec elle.',
      SLEEP_NOTE,
    ].join('\n'));
    console.log('deploy live: URLs published on the PR.');
  } else if (dep) {
    await upsertComment([
      intro(),
      `Le deploiement de la preview a echoue (statut Render : \`${dep.status}\`).`,
      "Verifier que l'image GHCR est publique et demarre en local, corriger puis relancer `/preview`. Aucun lien publie tant que rien n'est en ligne.",
      SLEEP_NOTE,
    ].join('\n'));
    console.log(`deploy ${dep.status}: failure posted, no URL.`);
  } else {
    await upsertComment([
      intro(),
      `Deploiement toujours en cours apres ~${Math.round(WAIT_MAX_MS / 60000)} min : le suivi automatique s'arrete ici, mais Render continue.`,
      'Des que le service sera en ligne, le prochain push (ou `/preview`) mettra a jour ce commentaire avec les liens.',
    ].join('\n'));
    console.log('deploy watch timed out: noted on the PR, Render keeps deploying.');
  }
}

async function cleanup() {
  const s = await findService(name);
  if (s) await render('DELETE', `/services/${s.id}`);
  await upsertComment(`### Preview Render pour la PR #${pr}\nPR fermee : le service de preview (et ses donnees Dolt embarquees) a ete supprime.`);
}

export { ensure, refresh, cleanup, ensureImageBuilt };

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  if (MODE === 'ensure') await ensure();
  else if (MODE === 'refresh') await refresh();
  else if (MODE === 'cleanup') await cleanup();
  else throw new Error('usage: ensure|refresh|cleanup');
}
