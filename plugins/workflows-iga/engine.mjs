/**
 * workflows-iga plugin: the local workflow runner (the DEFAULT execution path, used by the hosted demo
 * which has no Temporal server). Steps run sequentially in topological order inside the API process.
 * The execution logic lives in this folder; the core adapter only holds the in-memory run registry,
 * wires the dependencies (store, Dolt versioning) and resumes interrupted runs on boot.
 *
 * Honest scope:
 *  - SIMULATED steps only produce log lines (a wait actually waits; a notification is never sent;
 *    a fail step fails on its first attempt and recovers on retry, unless mode=always). They prove
 *    orchestration, retry and tracking, nothing else.
 *  - REAL data steps write on the run's own Dolt branch `wf-<run>` (created from main), one commit
 *    per step, with a SoD check after assignment changes. Main is never written by a run.
 *  - A run interrupted by an API restart is RESUMED from its pending steps on boot (state is in _meta).
 *  - The Temporal execution path (optional, IAM_TEMPORAL_ADDR) is wired separately; this local runner
 *    is NOT Temporal and is never presented as such.
 *
 * deps = {
 *   store                          -> the core run/step persistence (WorkflowStore)
 *   versioning: { createBranch(branch, base), writeOn(branch, fn), defaultBranch }
 *   authorOf(actor)                -> Dolt commit author string
 *   branchRun(branch, fn)          -> run fn inside the workspace branch context
 *   log: { warn(msg), error(msg) }
 * }
 */
import { STEP_TYPES, validateGraph } from './model.mjs';

const SOD_SQL = `select a.identity_id as identity, r.role_a as roleA, r.role_b as roleB
  from assignments a join assignments b on a.identity_id = b.identity_id
  join sod_rules r on r.role_a = a.role_id and r.role_b = b.role_id`;

class Canceled extends Error { constructor() { super('run canceled'); } }
const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
async function commit(c, message, author) {
  await c.query("CALL DOLT_ADD('-A')");
  const [r] = await c.query("CALL DOLT_COMMIT('-m', ?, '--author', ?)", [message, author]);
  return String(r[0].hash);
}

export function createWorkflowEngine(deps) {
  const store = deps.store;
  const log = deps.log ?? { warn: () => {}, error: () => {} };
  const live = new Map();

  /** Resume runs cut by a restart: their pending steps continue; a finished step is never re-done blindly
   *  (a data step that crashed mid-write left its branch working set reset by writeOn, so re-running is safe). */
  async function resume() {
    try { for (const r of await store.runningRuns()) kick(r.id); } catch (e) { log.warn(`resume scan failed: ${e.message}`); }
  }

  /** Starts the asynchronous execution of a run already recorded as queued. Returns immediately. */
  function kick(runId) {
    live.set(runId, { cancel: false });
    void execute(runId).catch(async (e) => {
      log.error(`run ${runId} crashed: ${e.message}`);
      try { await store.updateRun(runId, { status: 'failed', error: `internal error: ${e.message}`.slice(0, 500), finished_at: now() }); } catch { /* store gone */ }
    });
  }
  const cancelFlag = (runId) => { live.get(runId).cancel = true; };
  const forget = (runId) => { live.delete(runId); };

  async function execute(runId) {
    const run = await store.getRunById(runId);
    if (!run || run.status === 'canceled' || run.status === 'completed') return;
    await store.updateRun(runId, { status: 'running', error: null });
    const { order } = validateGraph(run.graph);
    const nodes = new Map(run.graph.nodes.map((n) => [n.id, n]));

    for (const nodeId of order) {
      const flag = live.get(runId);
      if (flag?.cancel) { await store.updateRun(runId, { status: 'canceled', finished_at: now() }); return; }
      const step = await store.step(runId, nodeId);
      if (!step || step.status !== 'pending') continue; // done/failed handled elsewhere; skipped stays skipped
      const node = nodes.get(nodeId);
      const ok = await runStep(run, node, step);
      if (!ok) {
        const after = await store.getRunById(runId);
        if (after?.status === 'failed') {
          // Mark everything still pending as skipped so the failure is visible end to end.
          for (const s of await store.steps(runId)) if (s.status === 'pending') await store.patchStep(runId, s.node_id, { status: 'skipped' });
        }
        return; // run status already set by runStep (failed or canceled)
      }
    }
    await store.updateRun(runId, { status: 'completed', finished_at: now() });
    live.delete(runId);
  }

  /** Runs ONE step. On failure: step failed + run failed, returns false. */
  async function runStep(run, node, step) {
    const logs = [...step.log];
    const say = (line) => { logs.push(`${now()} ${line}`); };
    say(`step started (${STEP_TYPES[node.type].simulated ? 'SIMULATED - no external effect' : 'REAL data change on branch ' + (run.branch ?? 'pending')})`);
    await store.patchStep(run.id, node.id, { status: 'running', started_at: step.started_at ?? now(), attempts: step.attempts + 1, log: logs, error: null });
    try {
      if (STEP_TYPES[node.type].simulated) await simulated(run, node, step.attempts, say);
      else await dataStep(run, node, say);
      await store.patchStep(run.id, node.id, { status: 'done', finished_at: now(), log: logs });
      return true;
    } catch (e) {
      say(`FAILED: ${e.message}`);
      if (e instanceof Canceled) {
        await store.patchStep(run.id, node.id, { status: 'pending', error: null, log: logs });
        await store.updateRun(run.id, { status: 'canceled', error: null, finished_at: now() });
      } else {
        await store.patchStep(run.id, node.id, { status: 'failed', error: e.message.slice(0, 500), finished_at: now(), log: logs });
        await store.updateRun(run.id, { status: 'failed', error: `step "${node.name}" failed: ${e.message}`.slice(0, 500), finished_at: now() });
      }
      live.delete(run.id);
      return false;
    }
  }

  async function simulated(run, node, attempts, say) {
    const cfg = node.config;
    switch (node.type) {
      case 'wait': {
        const seconds = Number(cfg.seconds ?? 2);
        say(`simulated wait of ${seconds}s (a real integration would poll or wait for an event)`);
        const until = Date.now() + seconds * 1000;
        while (Date.now() < until) {
          if (live.get(run.id)?.cancel) throw new Canceled();
          await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
        }
        say('wait finished');
        break;
      }
      case 'notify':
        say(`SIMULATED notification to "${String(cfg.recipient)}": ${String(cfg.message)}`);
        say('nothing was sent: no e-mail, no message, no external call (demo on purpose)');
        break;
      case 'fail': {
        if (cfg.mode === 'always') {
          say('this step is configured to fail on every attempt (mode "always"), to show a permanently blocked run');
          throw new Error(String(cfg.message ?? 'step configured to fail'));
        }
        if (attempts === 0) {
          say('simulates an external system that fails on the first call, to demonstrate error tracking');
          throw new Error(String(cfg.message ?? 'step configured to fail'));
        }
        say('SIMULATED recovery: the external system answers on retry (demo convention, no real call ever happens)');
        break;
      }
    }
  }

  /** Real data steps: lazily create the run branch, then write + SoD-check + commit on it. Never main. */
  async function dataStep(run, node, say) {
    const cfg = node.config;
    if (!run.branch) {
      const branch = `workflow/${run.id.replace(/^run-/, '').slice(0, 8)}`;
      const base = run.base_branch ?? deps.versioning.defaultBranch; // a triggered run branches from the branch its event happened on
      await deps.versioning.createBranch(branch, base);
      await store.updateRun(run.id, { branch });
      run.branch = branch;
      say(`created Dolt branch ${branch} from ${base}: every data change of this run stays on it until a human review merges it`);
    }
    const branch = run.branch;
    const author = deps.authorOf(`wf-${run.started_by}`);
    await deps.branchRun(branch, () => deps.versioning.writeOn(branch, async (c) => {
      switch (node.type) {
        case 'assign-role': {
          const [ok] = await c.query('select (select count(*) from identities where id = ?) as i, (select count(*) from roles where id = ?) as r', [cfg.identity, cfg.role]);
          const k = ok[0];
          if (!k.i) throw new Error(`unknown identity "${String(cfg.identity)}"`);
          if (!k.r) throw new Error(`unknown role "${String(cfg.role)}"`);
          await c.query('INSERT IGNORE INTO assignments VALUES (?, ?)', [cfg.identity, cfg.role]);
          const [dirty] = await c.query('select count(*) n from dolt_status');
          if (!Number(dirty[0].n)) { say(`${String(cfg.identity)} already has role "${String(cfg.role)}" on this branch: no change, nothing committed`); break; }
          const [viol] = await c.query(SOD_SQL);
          const hash = await commit(c, `workflow ${run.id}: assign ${String(cfg.role)} to ${String(cfg.identity)}`, author);
          say(`assignment written and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          if (viol.length) say(`warning: ${viol.length} SoD conflict(s) now present on this branch (e.g. ${viol[0].identity}: ${viol[0].roleA} + ${viol[0].roleB}); the review merge will refuse them`);
          else say('SoD check on the branch: no conflict');
          break;
        }
        case 'revoke-role': {
          const [res] = await c.query('DELETE FROM assignments WHERE identity_id = ? AND role_id = ?', [cfg.identity, cfg.role]);
          if (!Number(res.affectedRows)) throw new Error(`${String(cfg.identity)} does not have role "${String(cfg.role)}" on this branch`);
          const hash = await commit(c, `workflow ${run.id}: revoke ${String(cfg.role)} from ${String(cfg.identity)}`, author);
          say(`assignment removed and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          break;
        }
        case 'set-department': {
          const [res] = await c.query('UPDATE identities SET department = ? WHERE id = ?', [cfg.department, cfg.identity]);
          if (!Number(res.affectedRows)) {
            const [chk] = await c.query('select count(*) n from identities where id = ?', [cfg.identity]);
            if (!Number(chk[0].n)) throw new Error(`unknown identity "${String(cfg.identity)}"`);
            say(`department already "${String(cfg.department)}": no change, nothing committed`);
            break;
          }
          const hash = await commit(c, `workflow ${run.id}: ${String(cfg.identity)} moves to ${String(cfg.department)}`, author);
          say(`department updated and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          break;
        }
        case 'set-profile-field': {
          const [chk] = await c.query('select count(*) n from identities where id = ?', [cfg.identity]);
          if (!Number(chk[0].n)) throw new Error(`unknown identity "${String(cfg.identity)}"`);
          await c.query('create table if not exists profile_field_values (tenant varchar(32) not null, subject varchar(32) not null, field_key varchar(80) not null, value json not null, primary key (tenant, subject, field_key))');
          await c.query('insert into profile_field_values values (?,?,?,?) on duplicate key update value=values(value)', [run.tenant, cfg.identity, cfg.field, JSON.stringify(cfg.value)]);
          const [dirty] = await c.query("select count(*) n from dolt_status where table_name='profile_field_values'");
          if (!Number(dirty[0].n)) { say(`profile field "${String(cfg.field)}" already has this value: no change, nothing committed`); break; }
          const hash = await commit(c, `workflow ${run.id}: record ${String(cfg.field)} for ${String(cfg.identity)}`, author);
          say(`profile field "${String(cfg.field)}" recorded and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          break;
        }
      }
    }));
  }

  return { resume, kick, cancelFlag, forget };
}

export { hasDataSteps } from './model.mjs';
