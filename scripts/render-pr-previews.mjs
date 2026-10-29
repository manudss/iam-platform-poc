#!/usr/bin/env node
// Orchestrates the per-PR Render preview service (one all-in-one Docker web service:
// Dolt + Rust core + NestJS API + Angular console, built from demo/Dockerfile) from a
// TRUSTED GitHub Actions workflow (pull_request_target, base-branch code only, never PR code).
// Untrusted values (branch name) only travel through env vars and are validated here.
// Usage: node scripts/render-pr-previews.mjs ensure|cleanup
// Env: RENDER_API_KEY, RENDER_OWNER_ID, RENDER_ENVIRONMENT_ID, GITHUB_TOKEN, GITHUB_REPOSITORY,
//      PR_NUMBER, PR_HEAD_BRANCH, PR_HEAD_SHA (ensure only), DRY_RUN=1 to print the plan only.
const MODE = process.argv[2];
const e = process.env;
const DRY = e.DRY_RUN === '1';
const pr = Number(e.PR_NUMBER);
if (!Number.isInteger(pr) || pr <= 0) throw new Error('PR_NUMBER invalid');
const repoFull = e.GITHUB_REPOSITORY ?? '';
if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull)) throw new Error('GITHUB_REPOSITORY invalid');
const branch = e.PR_HEAD_BRANCH ?? '';
if (MODE === 'ensure' && !/^[\w./-]{1,200}$/.test(branch)) throw new Error('PR_HEAD_BRANCH rejected');
const headSha = e.PR_HEAD_SHA ?? '';
if (MODE === 'ensure' && !/^[0-9a-f]{40}$/.test(headSha)) throw new Error('PR_HEAD_SHA rejected');

const RENDER = 'https://api.render.com/v1';
const name = `iam-pr${pr}`;
const MARK = '<!-- render-previews-iam -->';

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

async function ensure() {
  const repo = `https://github.com/${repoFull}`;
  if (!e.RENDER_ENVIRONMENT_ID) throw new Error('RENDER_ENVIRONMENT_ID is required (IAM POOC project, dev environment)');
  const guess = `https://${name}.onrender.com`;

  // The all-in-one demo image needs demo/Dockerfile in the PR branch; skip cleanly otherwise.
  const dockerfile = await gh('GET', `/contents/demo/Dockerfile?ref=${headSha}`);
  if (!dockerfile) {
    await upsertComment([
      `### Preview Render pour la PR #${pr}`,
      `Pas de preview automatique : cette branche ne contient pas \`demo/Dockerfile\` (image Docker tout-en-un Dolt + core + API + console).`,
      'Ajoute ce fichier sur la branche pour obtenir une preview a la prochaine mise a jour de la PR.',
    ].join('\n'));
    console.log('demo/Dockerfile absent from the PR branch: no preview created.');
    return;
  }

  let svc = await findService(name);
  let created = false;
  if (!svc) {
    const r = await render('POST', '/services', {
      ownerId: e.RENDER_OWNER_ID,
      environmentId: e.RENDER_ENVIRONMENT_ID,
      // autoDeploy 'no' ON PURPOSE: Render's own webhook AND the workflow's explicit
      // deploy call would otherwise start two builds of the same SHA at each PR update
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
    const vars = await render('GET', `/services/${svc.id}/env-vars`);
    const current = (Array.isArray(vars) ? vars : []).map((x) => x.envVar ?? x).find((v) => v.key === 'IAM_PUBLIC_ORIGIN');
    if (!current || current.value !== realUrl) {
      await render('PUT', `/services/${svc.id}/env-vars/IAM_PUBLIC_ORIGIN`, { value: realUrl });
      envRedeploy = true;
    }
  }
  if (!created && !envRedeploy) {
    // PR update: do not rely on Render's GitHub webhook; explicitly deploy the newest commit of the branch.
    await render('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
  }

  await upsertComment([
    `### Preview Render pour la PR #${pr}`,
    `| Composant | Lien |`, '|---|---|',
    `| Demo tout-en-un (console + API + core + Dolt) | ${realUrl} |`,
    `| Sante | ${realUrl}/healthz |`,
    '',
    'Un seul service Docker gratuit (plan Free, Frankfurt), construit depuis `demo/Dockerfile` de cette branche, dans le projet Render **IAM POOC** (environnement `dev`).',
    'Les donnees Dolt sont les seeds fictives embarquees dans le conteneur : elles sont propres a cette preview et disparaissent avec elle.',
    'Le service se met en veille apres 15 min sans trafic (le premier appel peut prendre ~1 min) et chaque mise a jour de la branche relance un build Docker (compte dans les minutes de pipeline gratuites).',
    'Il est supprime a la fermeture de la PR.',
  ].join('\n'));
}

async function cleanup() {
  const s = await findService(name);
  if (s) await render('DELETE', `/services/${s.id}`);
  await upsertComment(`### Preview Render pour la PR #${pr}\nPR fermee : le service de preview (et ses donnees Dolt embarquees) a ete supprime.`);
}

if (MODE === 'ensure') await ensure();
else if (MODE === 'cleanup') await cleanup();
else throw new Error('usage: ensure|cleanup');
