#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Orchestrates the per-PR Render preview service (one all-in-one Docker web service:
// Dolt + Rust core + NestJS API + Angular console, built from demo/Dockerfile) from a
// TRUSTED GitHub Actions workflow (pull_request_target, or issue_comment /
// workflow_dispatch which run the DEFAULT branch version: never PR code).
//
// DEPLOY ON DEMAND (since 2026-10-30): a push on a PR branch NEVER starts a Render
// build. Each Docker build (Rust + Node multi-stage) costs ~10-20 of the 500 free
// pipeline minutes/month shared by the workspace, so the preview only builds when
// someone actually wants to test:
//   - ensure   (PR opened / updated): no build, no service creation. Only maintains
//              the status comment on the PR. No URL is shown before the service has
//              a LIVE deploy (no dead/placeholder links on the PR).
//   - refresh  (`/preview` PR comment from OWNER/MEMBER/COLLABORATOR, or the manual
//              Actions dispatch): creates the service if needed, deploys the latest
//              commit of the PR branch, then WAITS for the Render deploy outcome and
//              publishes the URLs in the PR comment only once the preview is live
//              (or a failure note without links when the build fails).
//              The head branch/sha are read back from the GitHub API here, never
//              taken from event or env metadata.
//   - cleanup  (PR closed): deletes the service.
// Untrusted values (branch name) are validated before use. Infra secrets
// (RENDER_API_KEY) stay in the trusted workflow and never reach the preview service.
// Usage: node scripts/render-pr-previews.mjs ensure|refresh|cleanup
// Env: RENDER_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER,
//      RENDER_OWNER_ID + RENDER_ENVIRONMENT_ID (refresh only, service creation),
//      PREVIEW_POLL_MS / PREVIEW_WAIT_MAX_MS (deploy watch tuning, tests use tiny
//      values), DRY_RUN=1 to print the plan only.
const MODE = process.argv[2];
const e = process.env;
const DRY = e.DRY_RUN === '1';
const pr = Number(e.PR_NUMBER);
if (!Number.isInteger(pr) || pr <= 0) throw new Error('PR_NUMBER invalid');
const repoFull = e.GITHUB_REPOSITORY ?? '';
if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull)) throw new Error('GITHUB_REPOSITORY invalid');

const RENDER = 'https://api.render.com/v1';
const name = `iam-pr${pr}`;
const MARK = '<!-- render-previews-iam -->';
const POLL_MS = Number(e.PREVIEW_POLL_MS ?? 30000);
const WAIT_MAX_MS = Number(e.PREVIEW_WAIT_MAX_MS ?? 26 * 60 * 1000);
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

// ensure: PR opened/updated. Never builds; only keeps the status comment accurate.
// Rule: no URL on the PR while no deploy is live (a placeholder link would be dead).
async function ensure() {
  const svc = await findService(name);
  const guess = `https://${name}.onrender.com`;
  if (!svc) {
    await upsertComment([
      intro(),
      '**Preview a la demande** : les pushes ne lancent plus de build (chaque build Docker consomme une part des 500 minutes de pipeline gratuites partagees du mois).',
      '',
      HOWTO,
      '',
      "Une fois construite depuis `demo/Dockerfile` (tout-en-un : Dolt + core + API + console), l'URL de la preview sera publiee ici automatiquement - aucun lien tant que rien n'est en ligne. Le service est supprime a la fermeture de la PR.",
    ].join('\n'));
    console.log('no preview service: status comment only, no build, no URL.');
    return;
  }
  const realUrl = urlOf(svc, guess);
  const d = await latestDeploy(svc.id);
  if (d?.status !== 'live') {
    await upsertComment([
      intro(),
      `Preview pas encore en ligne (dernier build Render : \`${d?.status ?? 'aucun'}\`). Les liens seront publies ici des qu'elle sera prete.`,
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
  console.log('preview live: status comment refreshed, no build.');
}

// refresh: explicit request to (re)deploy the latest commit of the PR branch,
// then watch the build and publish the URLs only once the preview is live.
async function refresh() {
  // Read the head back from the API: never trust event/env metadata for what gets built.
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

  if (!e.RENDER_ENVIRONMENT_ID) throw new Error('RENDER_ENVIRONMENT_ID is required (IAM POOC project, dev environment)');
  const repo = `https://github.com/${repoFull}`;
  const guess = `https://${name}.onrender.com`;

  const started = Date.now();
  let svc = await findService(name);
  let created = false;
  if (!svc) {
    const r = await render('POST', '/services', {
      ownerId: e.RENDER_OWNER_ID,
      environmentId: e.RENDER_ENVIRONMENT_ID,
      // autoDeploy 'no' ON PURPOSE: Render's own webhook AND the workflow's explicit
      // deploy call would otherwise start two builds of the same SHA
      // (observed on the Allegria previews). The workflow is the single deploy trigger.
      repo, branch, autoDeploy: 'no',
      type: 'web_service', name,
      envVars: [{ key: 'IAM_PUBLIC_ORIGIN', value: guess }],
      serviceDetails: {
        runtime: 'docker', plan: 'free', region: 'frankfurt', healthCheckPath: '/healthz',
        envSpecificDetails: { dockerfilePath: 'demo/Dockerfile', dockerContext: '.' },
      },
    });
    svc = r.service ?? r;
    created = true;
  }
  const realUrl = urlOf(svc, guess);

  // The public origin must be the real URL (a name collision can add a suffix).
  // Changing an env var makes Render redeploy by itself, so skip the explicit deploy in that case.
  let envRedeploy = false;
  if (!created) {
    // Track the branch the service points at: a PR whose head branch was force-renamed
    // would otherwise keep building the old ref. Same-name branch: nothing to do.
    const vars = await render('GET', `/services/${svc.id}/env-vars`);
    const current = (Array.isArray(vars) ? vars : []).map((x) => x.envVar ?? x).find((v) => v.key === 'IAM_PUBLIC_ORIGIN');
    if (!current || current.value !== realUrl) {
      await render('PUT', `/services/${svc.id}/env-vars/IAM_PUBLIC_ORIGIN`, { value: realUrl });
      envRedeploy = true;
    }
  }
  if (!created && !envRedeploy) {
    // Explicit demand: deploy the newest commit of the branch (one build only).
    await render('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
  }

  // 1. Acknowledge immediately, WITHOUT the URL: until the first build is live the
  //    link would be dead, so the PR never shows it.
  await upsertComment([
    intro(),
    `Preview demandee : build Docker du commit \`${sha.slice(0, 7)}\` lance.`,
    '',
    "Les liens seront publies ici des que la preview sera en ligne (compter ~10-20 min de build Docker) - aucun lien avant, l'URL ne repondrait pas.",
    SLEEP_NOTE,
  ].join('\n'));

  // 2. Watch the deploy, then publish the outcome.
  const dep = await waitForDeploy(svc.id, started);
  if (dep?.status === 'live') {
    await upsertComment([
      intro(),
      `**Preview en ligne** (commit \`${sha.slice(0, 7)}\`) :`,
      '',
      links(realUrl),
      '',
      'Un seul service Docker gratuit (plan Free, Frankfurt), construit depuis `demo/Dockerfile` de cette branche, dans le projet Render **IAM POOC** (environnement `dev`).',
      'Les donnees Dolt sont les seeds fictives embarquees dans le conteneur : elles sont propres a cette preview et disparaissent avec elle.',
      SLEEP_NOTE,
    ].join('\n'));
    console.log('deploy live: URLs published on the PR.');
  } else if (dep) {
    await upsertComment([
      intro(),
      `Le build de la preview a echoue (statut Render : \`${dep.status}\`).`,
      'Corriger puis relancer `/preview`. Aucun lien publie tant que rien n\'est en ligne.',
      SLEEP_NOTE,
    ].join('\n'));
    console.log(`deploy ${dep.status}: failure posted, no URL.`);
  } else {
    await upsertComment([
      intro(),
      `Build toujours en cours apres ~${Math.round(WAIT_MAX_MS / 60000)} min : le suivi automatique s'arrete ici, mais Render continue.`,
      'Des que le service sera en ligne, le prochain push (ou `/preview`) mettra a jour ce commentaire avec les liens.',
    ].join('\n'));
    console.log('deploy watch timed out: noted on the PR, Render keeps building.');
  }
}

async function cleanup() {
  const s = await findService(name);
  if (s) await render('DELETE', `/services/${s.id}`);
  await upsertComment(`### Preview Render pour la PR #${pr}\nPR fermee : le service de preview (et ses donnees Dolt embarquees) a ete supprime.`);
}

export { ensure, refresh, cleanup };

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  if (MODE === 'ensure') await ensure();
  else if (MODE === 'refresh') await refresh();
  else if (MODE === 'cleanup') await cleanup();
  else throw new Error('usage: ensure|refresh|cleanup');
}
