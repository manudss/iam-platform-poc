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
 *   settingsFor(tenant, branch, pluginId) -> the validated settings (secrets resolved) of a block provider plugin
 *   log: { warn(msg), error(msg) }
 * }
 *
 * EXTERNAL blocks (type contributed by a workflows.blocks provider plugin, e.g. workflow-connectors):
 *  - {{steps.<id>.<key>}} placeholders are resolved at step time from the outputs of finished steps;
 *  - the block receives the provider plugin's console-typed settings (Jira / Google credentials live there);
 *  - a block writing business data uses ctx.branchWrite(fn, message): same run branch, same per-step commit;
 *  - an EXTERNAL effect (HTTP call, Jira ticket, real Google write) is NOT reverted by abandoning the branch:
 *    the block's own log line says exactly what really happened outside (dry-run or real).
 */
import { createRequire } from 'node:module';
import { STEP_TYPES, WorkflowSuspend, externalBlock, externalBlockProvider, loopBody, stepCategory, substituteStepOutputs, validateGraph } from './model.mjs';

const { HttpException } = createRequire(new URL('./package.json', import.meta.url))('@nestjs/common');
// The business-error allowlist: only a real HttpException thrown by OUR code (block validation, tasks,
// IGA, versioning services) with a safe business code is surfaced verbatim. A provider error that merely
// CARRIES a numeric .status (HTTP response, SDK failure) is masked like any other unexpected error.
const SAFE_BUSINESS_STATUS = new Set([400, 403, 404, 409, 422]);

const SOD_SQL = `select a.identity_id as identity, r.role_a as roleA, r.role_b as roleB
  from assignments a join assignments b on a.identity_id = b.identity_id
  join sod_rules r on r.role_a = a.role_id and r.role_b = b.role_id`;

class Canceled extends Error { constructor() { super('run canceled'); } }
/** Statuses from which a run may still move: every status write is an atomic transition from this set,
 *  so a terminal state (cancel/completed/failed) recorded concurrently always wins, with no read-then-write window. */
const RESUMABLE = ['queued', 'running', 'waiting'];
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

  /** Starts the asynchronous execution of a run already recorded as queued. Returns immediately.
   *  Executions of the SAME run are serialized: a kick landing while an execution is in flight (a
   *  second decision arriving mid-resume, a task rescan, a manual retry) only asks for one more pass
   *  once the current one settles. Without this, two concurrent passes both scan and patch the same
   *  step rows: one pass sees the other's in-flight 'running' step, mistakes it for a crash leftover
   *  and fails the run closed while the other pass completes the walk - a corrupt half-skipped run. */
  const executing = new Map();
  function kick(runId) {
    // A kick landing mid-pass only asks for one more pass: it must NEVER rewrite the live flag, or a
    // cancellation recorded during the current pass would be silently erased.
    const cur = executing.get(runId);
    if (cur) { cur.rekick = true; return; }
    if (!live.has(runId)) live.set(runId, { cancel: false });
    const state = { rekick: false };
    executing.set(runId, state);
    const pass = () => {
      void execute(runId).catch(async (e) => {
        log.error(`run ${runId} crashed: ${e.message}`);
        try {
          // A crash landing AFTER a terminal state (a user cancel, or a concurrent pass that finished the
          // run) must never rewrite it, not even in the window between a read and the write: the
          // transition is atomic, guarded by the source statuses (a canceled run stays canceled).
          await store.transitionRun(runId, { status: 'failed', error: `internal error: ${e.message}`.slice(0, 500), finished_at: now() }, RESUMABLE);
        } catch { /* store gone */ }
      }).finally(() => {
        if (state.rekick) { state.rekick = false; if (!live.has(runId)) live.set(runId, { cancel: false }); pass(); return; }
        executing.delete(runId);
        void disposeTestBranch(runId);
      });
    };
    pass();
  }

  /** A test run's branch is DISPOSABLE: once the run is terminal, the branch is dropped so a test
   *  leaves no residue (its steps' logs still say exactly what was written, and where). */
  async function disposeTestBranch(runId) {
    try {
      const run = await store.getRunById(runId);
      if (!run?.test || !run.branch || !deps.versioning.deleteBranch) return;
      if (!['completed', 'failed', 'canceled'].includes(run.status)) return;
      await deps.versioning.deleteBranch(run.branch);
      await store.updateRun(runId, { branch: `${run.branch} (dropped: disposable test branch)` });
    } catch (e) { log.warn(`test branch cleanup for run ${runId}: ${e.message}`); }
  }
  // Robust whether or not a pass currently holds the live flag (a suspended run dropped it): the cancel
  // survives and the next pass - or the walk - honors it, instead of crashing on a missing entry. When no
  // pass holds the flag, arm the cancel only for a run that is still resumable: a finished run gets NO
  // stale live entry (the map would otherwise keep one forever).
  // The flag carries the cancel's timestamp: a cancel on a parked (waiting/queued) run has no live pass to
  // consume it, so it would otherwise sit in the map and instantly re-cancel a later retry/rerun of that run.
  const cancelFlag = (runId) => {
    const at = Date.now();
    const f = live.get(runId);
    if (f) { f.cancel = at; return; }
    void store.getRunById(runId).then((r) => {
      if (!r || ['completed', 'failed', 'canceled'].includes(r.status)) return;
      const g = live.get(runId); if (g) g.cancel = at; else live.set(runId, { cancel: at });
    }).catch(() => { /* store gone */ });
  };
  // Called by a relaunch (retry/rerun) once it has claimed the run: drops a cancel flag stamped BEFORE the
  // claim (left over from the cancellation that was just reversed). A flag stamped AFTER the claim is a
  // fresh, concurrent cancellation and is never erased here.
  const clearStaleCancel = (runId, claimedAt) => {
    const f = live.get(runId);
    if (f && f.cancel && f.cancel < claimedAt) f.cancel = false;
  };
  const forget = (runId) => { live.delete(runId); };

  /** Steps whose type branches: after they succeed, only their outgoing link carrying the chosen label is taken. */
  const BRANCHERS = new Set(['if', 'switch', 'loop']);

  async function execute(runId) {
    const run = await store.getRunById(runId);
    if (!run || run.status === 'canceled' || run.status === 'completed') return;
    if (!await store.transitionRun(runId, { status: 'running', error: null }, RESUMABLE)) return; // turned terminal between the read and here
    // A restarted call may already have reached the remote service. Never continue past it.
    for (const st of await store.steps(runId)) if (st.error === 'EXTERNAL_EFFECT_REVIEW_REQUIRED' && st.status !== 'done') {
      await store.patchStep(runId, st.node_id, { status: 'failed', finished_at: now() });
      await store.transitionRun(runId, { status: 'failed', error: 'External effect uncertain: reconcile at the provider before creating a new run.', finished_at: now() }, RESUMABLE); return;
    }
    // A step left 'running' by a restart was cut in flight. A step that can have an effect outside the run (category real or any external block) is NEVER re-run by itself, and the run is
    // never reported completed over it: the run fails closed and the step is marked, for a manual reconciliation. A computed or simulated step has no effect and simply restarts.
    for (const st of await store.steps(runId)) if (st.status === 'running') {
      const n = run.graph.nodes.find((x) => x.id === st.node_id);
      const effectful = !n || externalBlock(n.type) || stepCategory(n.type) === 'real';
      if (!effectful) { await store.patchStep(runId, st.node_id, { status: 'pending' }); continue; }
      for (const o of await store.steps(runId)) if (o.status === 'pending') await store.patchStep(runId, o.node_id, { status: 'skipped' });
      await store.patchStep(runId, st.node_id, { status: 'failed', error: 'EXTERNAL_EFFECT_REVIEW_REQUIRED', finished_at: now() });
      await store.transitionRun(runId, { status: 'failed', error: `step "${n?.name ?? st.node_id}" was interrupted by a restart while it ran: its effect is unknown, reconcile before creating a new run.`.slice(0, 500), finished_at: now() }, RESUMABLE); return;
    }
    const { order } = validateGraph(run.graph);
    const nodes = new Map(run.graph.nodes.map((n) => [n.id, n]));
    const edges = run.graph.edges;
    // Loop bodies run inside their loop step, not in the main pass.
    const inBody = new Map();
    for (const n of run.graph.nodes) if (n.type === 'loop') for (const id of loopBody(run.graph, n.id)) inBody.set(id, n.id);
    // The branch label each branching step chose (rebuilt from stored outputs on a resumed run).
    const chosen = new Map();

    const canceled = async () => {
      await store.transitionRun(runId, { status: 'canceled', finished_at: now() }, RESUMABLE);
      live.delete(runId);
    };

    /** Is this link taken, given the current step rows? `loopId` makes the loop's `each` links read as taken while its body runs. */
    const edgeTaken = (e, stepsById, bodyOf = null) => {
      const p = stepsById.get(e.from);
      if (!p) return false;
      if (e.label === 'error') return p.status === 'failed';
      if (bodyOf && e.from === bodyOf) return e.label === 'each';
      if (p.status !== 'done') return false;
      const fromType = nodes.get(e.from)?.type;
      if (BRANCHERS.has(fromType)) return chosen.get(e.from) === e.label;
      return e.label === undefined; // a plain step: only its unlabeled links are taken on success
    };
    /** A merge runs as soon as ONE incoming link arrives; any other step needs ALL of them. */
    const arrival = (nodeId, stepsById, bodyOf = null) => {
      const incoming = edges.filter((e) => e.to === nodeId);
      if (!incoming.length) return 'run';
      const taken = incoming.map((e) => edgeTaken(e, stepsById, bodyOf));
      return (nodes.get(nodeId)?.type === 'merge' ? taken.some(Boolean) : taken.every(Boolean)) ? 'run' : 'skip';
    };
    /** A failure ends the run UNLESS the step has an error link: then that path continues instead. */
    const failOrBranch = async (node, message) => {
      if (message !== 'EXTERNAL_EFFECT_REVIEW_REQUIRED' && edges.some((e) => e.from === node.id && e.label === 'error')) {
        for (const s of await store.steps(runId)) if (s.output?.branch) chosen.set(s.node_id, s.output.branch);
        return true; // error links read taken from the step's failed status; the walk continues
      }
      for (const s of await store.steps(runId)) if (s.status === 'pending') await store.patchStep(runId, s.node_id, { status: 'skipped' });
      await store.transitionRun(runId, { status: 'failed', error: `step "${node.name}" failed: ${message}`.slice(0, 500), finished_at: now() }, RESUMABLE);
      live.delete(runId);
      return false;
    };

    for (const nodeId of order) {
      if (inBody.has(nodeId)) continue; // runs inside its loop step
      const flag = live.get(runId);
      if (flag?.cancel) { await canceled(); return; }
      const step = await store.step(runId, nodeId);
      if (!step) continue;
      if (step.status !== 'pending') { // resumed run: fold stored results back into the walk
        if (step.status === 'done' && step.output?.branch) chosen.set(nodeId, step.output.branch);
        continue;
      }
      const stepsById = new Map((await store.steps(runId)).map((s) => [s.node_id, s]));
      if (arrival(nodeId, stepsById) === 'skip') { await store.patchStep(runId, nodeId, { status: 'skipped' }); continue; }
      const node = nodes.get(nodeId);
      const arrived = edges.filter((e) => e.to === nodeId && edgeTaken(e, stepsById)).map((e) => e.from);
      const res = node.type === 'loop' ? await runLoop(run, node, step, edgeTaken) : await runStep(run, node, step, '', arrived);
      if (res.canceled) { await canceled(); return; }
      if (res.suspended) { live.delete(runId); return; } // parked on a durable human task: the task service kicks the run back
      if (!res.ok) { if (!(await failOrBranch(node, res.error))) return; continue; }
      if (res.output?.branch) chosen.set(nodeId, res.output.branch);
      if (node.type === 'loop') chosen.set(nodeId, 'done');
    }
    await store.transitionRun(runId, { status: 'completed', finished_at: now() }, RESUMABLE);
    live.delete(runId);
  }

  /** A loop step: resolves its items, then runs its body subgraph once per item (the loop step's own
   *  output carries the current {item, index, count}, so {{steps.<loop>.item}} resolves per iteration).
   *  Body step rows keep the LAST iteration's status/output; every iteration appends to their logs. */
  async function runLoop(run, node, step, edgeTaken) {
    const logs = [...step.log];
    const say = (line) => { logs.push(`${now()} ${line}`); };
    say('loop step started (COMPUTED - really iterates, no external effect by itself)');
    await store.patchStep(run.id, node.id, { status: 'running', started_at: step.started_at ?? now(), attempts: step.attempts + 1, log: logs, error: null });
    try {
      const outputs = {};
      for (const s of await store.steps(run.id)) if (s.output !== null && s.output !== undefined) outputs[s.node_id] = s.output;
      const resolved = substituteStepOutputs(node, outputs);
      await store.patchStep(run.id, node.id, { input: resolved.config });
      const max = Number(resolved.config.maxItems ?? 10);
      const items = parseItems(resolved.config.items, say);
      const capped = items.slice(0, max);
      if (capped.length < items.length) say(`item list truncated to the configured cap of ${max}`);
      say(`loop over ${capped.length} item(s)`);
      const body = validateGraph(run.graph).order.filter((id) => loopBody(run.graph, node.id).has(id));
      for (let i = 0; i < capped.length; i++) {
        if (live.get(run.id)?.cancel) throw new Canceled();
        say(`iteration ${i + 1}/${capped.length}`);
        await store.patchStep(run.id, node.id, { log: logs, output: { item: capped[i], index: i, count: capped.length } });
        for (const bid of body) {
          const bs = await store.step(run.id, bid);
          if (!bs) continue;
          const stepsById = new Map((await store.steps(run.id)).map((s) => [s.node_id, s]));
          const incoming = run.graph.edges.filter((e) => e.to === bid);
          const taken = incoming.map((e) => edgeTaken(e, stepsById, node.id));
          const go = !incoming.length ? true : (run.graph.nodes.find((n) => n.id === bid)?.type === 'merge' ? taken.some(Boolean) : taken.every(Boolean));
          if (!go) { await store.patchStep(run.id, bid, { status: 'skipped', log: [...bs.log, `${now()} iteration ${i + 1}: path not taken`] }); continue; }
          await store.patchStep(run.id, bid, { status: 'pending', error: null });
          const arrived = run.graph.edges.filter((e) => e.to === bid && edgeTaken(e, stepsById, node.id)).map((e) => e.from);
          const res = await runStep(run, run.graph.nodes.find((n) => n.id === bid), await store.step(run.id, bid), `iteration ${i + 1}: `, arrived);
          if (res.canceled) throw new Canceled();
          if (res.suspended) throw new Error(`body step "${bs.node_id}" tried to wait for a human decision: waiting steps belong AFTER the loop, not inside its body`);
          if (!res.ok) throw new Error(`body step "${bs.node_id}" failed on iteration ${i + 1}: ${res.error}`);
        }
      }
      await store.patchStep(run.id, node.id, { status: 'done', finished_at: now(), log: logs, output: { count: capped.length, branch: 'done' } });
      return { ok: true, output: { count: capped.length, branch: 'done' } };
    } catch (e) {
      if (e instanceof Canceled) { await store.patchStep(run.id, node.id, { status: 'pending', error: null, log: logs }); return { canceled: true }; }
      if ((await store.steps(run.id)).some(s => s.error === 'EXTERNAL_EFFECT_REVIEW_REQUIRED')) {
        const message = 'EXTERNAL_EFFECT_REVIEW_REQUIRED'; say('External effect uncertain. Automatic retry and error-route continuation are blocked; reconcile at the provider.');
        await store.patchStep(run.id, node.id, { status: 'failed', error: message, finished_at: now(), log: logs });
        return { ok: false, error: message };
      }
      say(`FAILED: ${e.message}`);
      await store.patchStep(run.id, node.id, { status: 'failed', error: e.message.slice(0, 500), finished_at: now(), log: logs });
      return { ok: false, error: e.message };
    }
  }

  /** The items of a loop step: a JSON array, or a newline/comma-separated list of texts. */
  function parseItems(raw, say) {
    const v = String(raw ?? '').trim();
    if (!v) return [];
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.slice(0, 500);
      if (parsed && typeof parsed === 'object') { say('the items value is an object, not a list: looping over its values'); return Object.values(parsed).slice(0, 500); }
      return [parsed];
    } catch {
      return v.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 500);
    }
  }

  /** The if/switch/merge steps: really evaluate their condition at run time, no external effect. */
  function logicStep(node, arrived, say) {
    const cfg = node.config;
    switch (node.type) {
      case 'if': {
        const l = String(cfg.left ?? ''), r = String(cfg.right ?? '');
        const ops = {
          equals: () => l === r, 'not-equals': () => l !== r,
          contains: () => l.includes(r), 'not-contains': () => !l.includes(r),
          'starts-with': () => l.startsWith(r), 'ends-with': () => l.endsWith(r),
          gt: () => Number(l) > Number(r), lt: () => Number(l) < Number(r),
          empty: () => l.trim() === '', 'not-empty': () => l.trim() !== '',
        };
        const fn = ops[cfg.op];
        if (!fn) throw new Error(`if: unknown operator "${String(cfg.op)}"`);
        if ((cfg.op === 'gt' || cfg.op === 'lt') && (!Number.isFinite(Number(l)) || !Number.isFinite(Number(r))))
          throw new Error(`if: "${cfg.op}" compares numbers, got "${l}" and "${r}"`);
        const result = fn();
        say(`condition ${cfg.op}: "${l}" ${cfg.op} "${r}" -> ${result}`);
        return { result, branch: result ? 'true' : 'false' };
      }
      case 'switch': {
        const v = String(cfg.value ?? '');
        const cases = String(cfg.cases ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        const matched = cases.includes(v) ? v : 'default';
        say(`switch on "${v}": ${matched === 'default' ? 'no case matched, taking default' : `case "${matched}" matched`}`);
        return { matched, branch: matched };
      }
      case 'merge':
        say(`joining paths: ${arrived.length} incoming link(s) arrived (${arrived.join(', ') || 'none'})`);
        return { arrived };
    }
    return {};
  }

  /** Runs ONE step. Returns {ok, output} | {ok: false, error} | {canceled: true}; the caller decides the
   *  run's fate (an error link can catch a failure and keep the run going). The resolved config is
   *  recorded as the step's INPUT, so a run can be audited placeholder by placeholder. */
  async function runStep(run, node, step, logPrefix = '', arrived = null) {
    const logs = [...step.log];
    const say = (line) => { logs.push(`${now()} ${logPrefix}${line}`); };
    const external = externalBlock(node.type);
    const cat = stepCategory(node.type);
    const effect = cat === 'computed' ? 'COMPUTED - really runs and computes its output, no external effect' : cat === 'simulated' ? 'SIMULATED, no external effect' : null;
    if (external)
      say(`step started (block "${external.label ?? node.type}" from the ${externalBlockProvider(node.type)} plugin${effect ? ' - ' + effect : ' - REAL-capable: the lines below say exactly what really happened outside lyam'})`);
    else
      say(`step started (${effect ?? 'REAL data change on branch ' + (run.branch ?? 'pending')})`);
    await store.patchStep(run.id, node.id, { status: 'running', started_at: step.started_at ?? now(), attempts: step.attempts + 1, log: logs, error: null });
    try {
      // Outputs apply to every node, including built-ins such as assign-role and notify.
      const outputs = {};
      for (const s of await store.steps(run.id)) if (s.output !== null && s.output !== undefined) outputs[s.node_id] = s.output;
      node = substituteStepOutputs(node, outputs);
      // The durable-wait payload recorded at the last suspension survives in the stored input: carry it
      // over the resolved-config rewrite so a resumed block still sees ctx.resumeWait.
      const priorWait = (await store.step(run.id, node.id))?.input?.wait;
      await store.patchStep(run.id, node.id, { input: priorWait ? { ...node.config, wait: priorWait } : node.config });
      let output;
      if (node.type === 'if' || node.type === 'switch' || node.type === 'merge') output = logicStep(node, arrived ?? [], say);
      else if (STEP_TYPES[node.type].simulated && !externalBlock(node.type)) await simulated(run, node, step.attempts, say);
      else if (externalBlock(node.type)) output = await externalStep(run, node, say);
      else output = await dataStep(run, node, say);
      await store.patchStep(run.id, node.id, { status: 'done', error: null, finished_at: now(), log: logs, output: output ?? null });
      return { ok: true, output: output ?? null };
    } catch (e) {
      if (e instanceof Canceled) {
        await store.patchStep(run.id, node.id, { status: 'pending', error: null, log: logs });
        return { canceled: true };
      }
      if (e instanceof WorkflowSuspend) {
        say(`WAITING for a human decision (${e.wait?.kind ?? 'task'}${e.wait?.taskId ? ' ' + e.wait.taskId : ''}): the run pauses here and resumes when the task is decided`);
        await store.patchStep(run.id, node.id, { status: 'pending', error: null, log: logs, input: { ...node.config, wait: e.wait } });
        await store.transitionRun(run.id, { status: 'waiting' }, RESUMABLE);
        return { suspended: true };
      }
      if ((await store.step(run.id, node.id))?.error === 'EXTERNAL_EFFECT_REVIEW_REQUIRED') {
        const message = 'EXTERNAL_EFFECT_REVIEW_REQUIRED'; say('External effect uncertain. Automatic retry and error-route continuation are blocked; reconcile at the provider.');
        await store.patchStep(run.id, node.id, { status: 'failed', error: message, finished_at: now(), log: logs });
        return { ok: false, error: message };
      }
      say(`FAILED: ${e.message}`);
      await store.patchStep(run.id, node.id, { status: 'failed', error: e.message.slice(0, 500), finished_at: now(), log: logs });
      return { ok: false, error: e.message };
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

  /** The run branch, created lazily on the first data-writing step. Never main. A test run's branch is
   *  named workflow/test-* and dropped when the run settles (disposable). */
  async function ensureBranch(run, say) {
    if (!run.branch) {
      const branch = `workflow/${run.test ? 'test-' : ''}${run.id.replace(/^run-/, '').slice(0, 8)}`;
      const base = run.base_branch ?? deps.versioning.defaultBranch; // a triggered run branches from the branch its event happened on
      await deps.versioning.createBranch(branch, base);
      await store.updateRun(run.id, { branch });
      run.branch = branch;
      say(`created Dolt branch ${branch} from ${base}: every data change of this run stays on it until a human review merges it`);
    }
    return run.branch;
  }

  /** An external block (contributed by a workflows.blocks provider plugin): placeholders from upstream
   * outputs, provider settings, and a branchWrite helper for blocks that write business data. */
  async function externalStep(run, node, say) {
    const block = externalBlock(node.type);
    const provider = externalBlockProvider(node.type);
    const outputs = {};
    for (const s of await store.steps(run.id)) if (s.output) outputs[s.node_id] = s.output;
    const priorInput = (await store.step(run.id, node.id))?.input;
    const resolved = substituteStepOutputs(node, outputs);
    const managed = /^(google-sheets-|jira-)/.test(node.type) || node.type === 'http-request';
    const simulation = managed && (run.test || resolved.config.executionMode !== 'real');
    let settings = {}, secret = '';
    if (managed && !simulation) {
      if (!resolved.config.connectionId || resolved.config.realConfirmed !== true || !deps.connectionFor) throw new Error('Real execution requires a confirmed managed connection');
      // The base ref is the approved configuration context, not the lazily created business-write branch.
      const connected = await deps.connectionFor(run.tenant, run.base_branch ?? deps.versioning.defaultBranch, resolved.config.connectionId, node.type);
      settings = connected.settings; secret = connected.secret;
      const creation = node.type === 'google-sheets-add-row' || node.type === 'jira-create-issue' || (node.type === 'http-request' && !['GET', 'HEAD'].includes(resolved.config.method));
      if (creation) await store.patchStep(run.id, node.id, { error: 'EXTERNAL_EFFECT_REVIEW_REQUIRED' });
    } else if (!managed) settings = provider && deps.settingsFor ? await deps.settingsFor(run.tenant, run.branch ?? run.base_branch, provider) : {};
    // A real mail is a non-repeatable external effect: if the process stops before the step is recorded done, the run stops for review (the provider idempotency key makes a deliberate new run return the same mail within 24 hours).
    if (node.type === 'lyam-send-mail' && !run.test) await store.patchStep(run.id, node.id, { error: 'EXTERNAL_EFFECT_REVIEW_REQUIRED' });
    // Publication to main: the branch and head are FROZEN by the run in this step's stored input BEFORE the call (durable intent). A resumed step reuses them; a branch that moved since is refused by the publisher.
    let publishIntent;
    if (node.type === 'lyam-publish-workspace' && !run.test && run.branch && deps.workspace) {
      const prior = (await store.steps(run.id)).find(s => s.node_id === node.id)?.input?.publishIntent;
      if (prior && prior.branch === run.branch && typeof prior.head === 'string') publishIntent = prior;
      else {
        const head = await deps.workspace.headOf(run.branch);
        if (!head) throw new Error('The run branch has no head to publish');
        publishIntent = { branch: run.branch, head };
        await store.patchStep(run.id, node.id, { input: { publishIntent } });
      }
    }
    const sensitive = [secret];
    if (secret) {
      sensitive.push(Buffer.from(`${settings.jiraEmail ?? ''}:${secret}`).toString('base64'));
      try { for (const value of Object.values(JSON.parse(secret))) if (typeof value === 'string' && value.length > 8) sensitive.push(value); } catch {}
    }
    // Run-scoped secrets (generated passwords) are redacted too, read at each call because a block may create one while it runs.
    const safe = value => { let text = String(value); for (const part of [...sensitive, ...(deps.secrets?.valuesOf?.(run.id) ?? [])].filter(Boolean)) for (const variant of [part, JSON.stringify(part).slice(1, -1), encodeURIComponent(part)]) text = text.split(variant).join('[redacted]'); return text; };

    say(`block "${block.label ?? node.type}" provided by the ${provider} plugin`);
    const author = deps.authorOf(`wf-${run.started_by}`);
    // The secret API a block gets depends on ITS type: only the generation block can create one, only set-temporary and the secret mail can resolve one (and only inside this run). No block ever receives a way to list them.
    const secretUse = { 'lyam-set-temporary-password': 'set-temporary', 'lyam-apply-password-reset': 'set-temporary', 'lyam-send-secret-mail': 'mail' }[node.type];
    const secrets = deps.secrets ? {
      generate: () => { if (node.type !== 'lyam-generate-password') throw new Error('secret reference unavailable'); return deps.secrets.create(run.id, ['set-temporary', 'mail']); },
      reveal: ref => { if (!secretUse) throw new Error('secret reference unavailable'); return deps.secrets.reveal(run.id, ref, secretUse); },
      drop: ref => deps.secrets.drop(run.id, ref),
    } : undefined;
    const ctx = {
      tenant: run.tenant,
      secrets,
      users: deps.users ? { firstAccess: (id, ref) => deps.users.firstAccess(run.tenant, id, ref), emailOf: (id, ref) => deps.users.emailOf(run.tenant, id, ref) } : undefined,
      setTemporaryPassword: deps.users ? async ({ id, password, hours }) => { const branch = await ensureBranch(run, say); return deps.users.setTemporary(run.tenant, { runId: run.id, branch, id, password, hours }); } : undefined,
      // Durable intent of an irreversible effect, written right before it: from then on a crash leaves the step in review (no automatic resend).
      markEffectPending: intent => store.patchStep(run.id, node.id, { error: 'EXTERNAL_EFFECT_REVIEW_REQUIRED', ...(intent ? { input: { effectIntent: intent } } : {}) }),
      // Ticket links: the engine binds tenant and run; a block gives only the ticket and the target it links.
      links: deps.links ? {
        put: l => deps.links.put(run.tenant, { ...l, runId: run.id }),
        claim: k => deps.links.claim(run.tenant, k, run.id),
        complete: k => deps.links.complete(run.tenant, k, run.id),
      } : undefined,
      runBranch: run.branch ?? null,
      config: managed ? { ...resolved.config, dryRun: simulation, ...(node.type.startsWith('google-sheets-') && !simulation ? { source: 'google' } : {}) } : resolved.config,
      settings,
      dryRun: simulation,
      log: line => say(safe(line)),
      outputs,
      // Account effects (block, unblock, security settings patch). A test run never applies them.
      accounts: deps.accounts,
      // Authentication effects (enrollment reads, immediate unenroll + demo-outbox notify, policy save on the run branch).
      authn: deps.authn,
      workspace: deps.workspace,
      workflowId: run.definition_id,
      publishIntent,
      hasRunBranch: !!run.branch,
      test: !!run.test,
      runId: run.id,
      nodeId: node.id,
      // Durable-wait context: the wait payload recorded when this step last suspended (its task id), the
      // run starter (anti-self-approval), the branch the run started from, and the shared business
      // services (durable tasks, reads, IGA recertification, child runs). Absent when the server has none.
      resumeWait: priorInput?.wait ?? null,
      startedBy: run.started_by,
      baseBranch: run.base_branch ?? deps.versioning.defaultBranch,
      tasks: deps.tasks,
      reads: deps.reads,
      iga: deps.iga,
      runs: deps.runs,
      publish: deps.publish,
      policies: deps.policies,
      pluginsAdmin: deps.pluginsAdmin,
      branchWrite: async (fn, message) => {
        const branch = await ensureBranch(run, say);
        await deps.branchRun(branch, () => deps.versioning.writeOn(branch, async (c) => {
          await fn(c);
          const [dirty] = await c.query('select count(*) n from dolt_status');
          if (!Number(dirty[0].n)) { say('no data change: nothing committed'); return; }
          const hash = await commit(c, message ?? `workflow ${run.id}: step ${node.id}`, author);
          say(`committed on ${branch} (commit ${hash.slice(0, 10)})`);
        }));
      },
    };
    let output;
    try { output = await block.run(ctx); } catch (e) {
      if (e instanceof WorkflowSuspend) throw e;
      // Public business errors (4xx thrown by the block's own validation, allowlisted) surface with their
      // message; anything else (provider errors, unexpected exceptions, messages carrying a secret) stays masked.
      const msg = typeof e?.message === 'string' ? e.message.slice(0, 500) : '';
      const leaks = deps.secrets && msg && deps.secrets.valuesOf(run.id).some((v) => v && msg.includes(v));
      if (e instanceof HttpException && SAFE_BUSINESS_STATUS.has(e.getStatus()) && msg && !leaks) { const pub = new Error(msg); pub.status = e.getStatus(); throw pub; }
      throw new Error('External action failed; check connection and provider status.');
    }
    // Fail closed: a block output (or what it logged) that carries a run secret is never stored.
    if (deps.secrets) { const text = JSON.stringify(output ?? {}); if (deps.secrets.valuesOf(run.id).some(v => v && text.includes(v))) throw new Error('External action failed; check connection and provider status.'); }
    if (managed && !simulation && ((node.type === 'jira-create-issue' && !output?.key) || (node.type === 'google-sheets-add-row' && !(Number(output?.rowNumber) > 0)) || (node.type === 'http-request' && !(Number(output?.status) >= 200 && Number(output?.status) < 400)))) throw new Error('External response did not confirm success.');
    if (managed && !simulation) { try { output = JSON.parse(safe(JSON.stringify(output ?? {}))); } catch { output = {}; } }

    if (output !== undefined && output !== null && typeof output !== 'object') return { value: String(output) };
    return output ?? {};
  }

  /** Real data steps: lazily create the run branch, then write + SoD-check + commit on it. Never main. */
  async function dataStep(run, node, say) {
    const cfg = node.config;
    const branch = await ensureBranch(run, say);
    const author = deps.authorOf(`wf-${run.started_by}`);
    let output = {};
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
          output = { identity: String(cfg.identity), role: String(cfg.role), dataRow: { table: 'assignments', pk: { identity_id: String(cfg.identity), role_id: String(cfg.role) } } };
          break;
        }
        case 'revoke-role': {
          const [res] = await c.query('DELETE FROM assignments WHERE identity_id = ? AND role_id = ?', [cfg.identity, cfg.role]);
          if (!Number(res.affectedRows)) throw new Error(`${String(cfg.identity)} does not have role "${String(cfg.role)}" on this branch`);
          const hash = await commit(c, `workflow ${run.id}: revoke ${String(cfg.role)} from ${String(cfg.identity)}`, author);
          say(`assignment removed and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          output = { identity: String(cfg.identity), role: String(cfg.role), dataRow: { table: 'assignments', pk: { identity_id: String(cfg.identity), role_id: String(cfg.role) }, removed: true } };
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
          output = { identity: String(cfg.identity), department: String(cfg.department), dataRow: { table: 'identities', pk: { id: String(cfg.identity) } } };
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
          output = { identity: String(cfg.identity), field: String(cfg.field), value: String(cfg.value), dataRow: { table: 'profile_field_values', pk: { tenant: run.tenant, subject: String(cfg.identity), field_key: String(cfg.field) } } };
          break;
        }
      }
    }));
    return output;
  }

  return { resume, kick, cancelFlag, clearStaleCancel, forget };
}

export { hasDataSteps } from './model.mjs';
