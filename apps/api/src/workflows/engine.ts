import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { branchContext } from '../workspace/context.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { authorOf } from '../versioning/guards.js';
import { hasDataSteps, STEP_TYPES, WfGraph, WfNode, validateGraph } from './model.js';
import { RunRow, StepRow, WorkflowStore } from './store.js';

const SOD_SQL = `select a.identity_id as identity, r.role_a as roleA, r.role_b as roleB
  from assignments a join assignments b on a.identity_id = b.identity_id
  join sod_rules r on r.role_a = a.role_id and r.role_b = b.role_id`;

/**
 * Local workflow runner (the DEFAULT execution path, used by the hosted demo which has no Temporal
 * server). Steps run sequentially in topological order inside the API process.
 *
 * Honest scope:
 *  - SIMULATED steps only produce log lines (a wait actually waits; a notification is never sent;
 *    a fail step fails on its first attempt and recovers on retry, unless mode=always). They prove orchestration, retry and tracking, nothing else.
 *  - REAL data steps write on the run's own Dolt branch `wf-<run>` (created from main), one commit
 *    per step, with a SoD check after assignment changes. Main is never written by a run.
 *  - A run interrupted by an API restart is RESUMED from its pending steps on boot (state is in _meta).
 *  - The Temporal execution path (optional, IAM_TEMPORAL_ADDR) is wired separately; this local runner
 *    is NOT Temporal and is never presented as such.
 */
@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly log = new Logger('workflows');
  private readonly live = new Map<string, { cancel: boolean }>();

  constructor(private readonly store: WorkflowStore, private readonly v: VersioningService) {}

  async onModuleInit() {
    // Resume runs cut by a restart: their pending steps continue; a finished step is never re-done blindly
    // (a data step that crashed mid-write left its branch working set reset by writeOn, so re-running is safe).
    try { for (const r of await this.store.runningRuns()) this.kick(r.id); } catch (e) { this.log.warn(`resume scan failed: ${(e as Error).message}`); }
  }

  /** Starts the asynchronous execution of a run already recorded as queued. Returns immediately. */
  kick(runId: string) {
    this.live.set(runId, { cancel: false });
    void this.execute(runId).catch(async (e) => {
      this.log.error(`run ${runId} crashed: ${(e as Error).message}`);
      try { await this.store.updateRun(runId, { status: 'failed', error: `internal error: ${(e as Error).message}`.slice(0, 500), finished_at: now() }); } catch { /* store gone */ }
    });
  }

  cancelFlag(runId: string) { this.live.get(runId)!.cancel = true; }
  forget(runId: string) { this.live.delete(runId); }

  private async execute(runId: string) {
    const run = await this.store.getRunById(runId);
    if (!run || run.status === 'canceled' || run.status === 'completed') return;
    await this.store.updateRun(runId, { status: 'running', error: null });
    const { order } = validateGraph(run.graph);
    const nodes = new Map(run.graph.nodes.map((n) => [n.id, n]));

    for (const nodeId of order) {
      const flag = this.live.get(runId);
      if (flag?.cancel) { await this.store.updateRun(runId, { status: 'canceled', finished_at: now() }); return; }
      const step = await this.store.step(runId, nodeId);
      if (!step || step.status !== 'pending') continue; // done/failed handled elsewhere; skipped stays skipped
      const node = nodes.get(nodeId)!;
      const ok = await this.runStep(run, node, step);
      if (!ok) {
        const after = await this.store.getRunById(runId);
        if (after?.status === 'failed') {
          // Mark everything still pending as skipped so the failure is visible end to end.
          for (const s of await this.store.steps(runId)) if (s.status === 'pending') await this.store.patchStep(runId, s.node_id, { status: 'skipped' });
        }
        return; // run status already set by runStep (failed or canceled)
      }
    }
    await this.store.updateRun(runId, { status: 'completed', finished_at: now() });
    this.live.delete(runId);
  }

  /** Runs ONE step. On failure: step failed + run failed, returns false. */
  private async runStep(run: RunRow, node: WfNode, step: StepRow): Promise<boolean> {
    const logs = [...step.log];
    const say = (line: string) => { logs.push(`${now()} ${line}`); };
    say(`step started (${STEP_TYPES[node.type].simulated ? 'SIMULATED - no external effect' : 'REAL data change on branch ' + (run.branch ?? 'pending')})`);
    await this.store.patchStep(run.id, node.id, { status: 'running', started_at: step.started_at ?? now(), attempts: step.attempts + 1, log: logs, error: null });
    try {
      if (STEP_TYPES[node.type].simulated) await this.simulated(run, node, step.attempts, say);
      else await this.dataStep(run, node, say);
      await this.store.patchStep(run.id, node.id, { status: 'done', finished_at: now(), log: logs });
      return true;
    } catch (e) {
      say(`FAILED: ${(e as Error).message}`);
      if (e instanceof Canceled) {
        await this.store.patchStep(run.id, node.id, { status: 'pending', error: null, log: logs });
        await this.store.updateRun(run.id, { status: 'canceled', error: null, finished_at: now() });
      } else {
        await this.store.patchStep(run.id, node.id, { status: 'failed', error: (e as Error).message.slice(0, 500), finished_at: now(), log: logs });
        await this.store.updateRun(run.id, { status: 'failed', error: `step "${node.name}" failed: ${(e as Error).message}`.slice(0, 500), finished_at: now() });
      }
      this.live.delete(run.id);
      return false;
    }
  }

  private async simulated(run: RunRow, node: WfNode, attempts: number, say: (l: string) => void) {
    const cfg = node.config;
    switch (node.type) {
      case 'wait': {
        const seconds = Number(cfg.seconds ?? 2);
        say(`simulated wait of ${seconds}s (a real integration would poll or wait for an event)`);
        const until = Date.now() + seconds * 1000;
        while (Date.now() < until) {
          if (this.live.get(run.id)?.cancel) throw new Canceled();
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
  private async dataStep(run: RunRow, node: WfNode, say: (l: string) => void) {
    const cfg = node.config;
    if (!run.branch) {
      const branch = `wf-${run.id.replace(/^run-/, '').slice(0, 8)}`;
      const base = run.base_branch ?? this.v.defaultBranch; // a triggered run branches from the branch its event happened on
      await this.v.createBranch(branch, base);
      await this.store.updateRun(run.id, { branch });
      run.branch = branch;
      say(`created Dolt branch ${branch} from ${base}: every data change of this run stays on it until a human review merges it`);
    }
    const branch = run.branch;
    const author = authorOf(`wf-${run.started_by}`);
    await branchContext.run({ branch }, () => this.v.writeOn(branch, async (c) => {
      switch (node.type) {
        case 'assign-role': {
          const [ok] = await c.query('select (select count(*) from identities where id = ?) as i, (select count(*) from roles where id = ?) as r', [cfg.identity, cfg.role]);
          const k = (ok as { i: number; r: number }[])[0];
          if (!k.i) throw new Error(`unknown identity "${String(cfg.identity)}"`);
          if (!k.r) throw new Error(`unknown role "${String(cfg.role)}"`);
          await c.query('INSERT IGNORE INTO assignments VALUES (?, ?)', [cfg.identity, cfg.role]);
          const [dirty] = await c.query('select count(*) n from dolt_status');
          if (!Number((dirty as { n: number }[])[0].n)) { say(`${String(cfg.identity)} already has role "${String(cfg.role)}" on this branch: no change, nothing committed`); break; }
          const [viol] = await c.query(SOD_SQL);
          const v = viol as { identity: string; roleA: string; roleB: string }[];
          const hash = await commit(c, `workflow ${run.id}: assign ${String(cfg.role)} to ${String(cfg.identity)}`, author);
          say(`assignment written and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          if (v.length) say(`warning: ${v.length} SoD conflict(s) now present on this branch (e.g. ${v[0].identity}: ${v[0].roleA} + ${v[0].roleB}); the review merge will refuse them`);
          else say('SoD check on the branch: no conflict');
          break;
        }
        case 'revoke-role': {
          const [res] = await c.query('DELETE FROM assignments WHERE identity_id = ? AND role_id = ?', [cfg.identity, cfg.role]);
          if (!Number((res as { affectedRows: number }).affectedRows)) throw new Error(`${String(cfg.identity)} does not have role "${String(cfg.role)}" on this branch`);
          const hash = await commit(c, `workflow ${run.id}: revoke ${String(cfg.role)} from ${String(cfg.identity)}`, author);
          say(`assignment removed and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          break;
        }
        case 'set-department': {
          const [res] = await c.query('UPDATE identities SET department = ? WHERE id = ?', [cfg.department, cfg.identity]);
          if (!Number((res as { affectedRows: number }).affectedRows)) {
            const [chk] = await c.query('select count(*) n from identities where id = ?', [cfg.identity]);
            if (!Number((chk as { n: number }[])[0].n)) throw new Error(`unknown identity "${String(cfg.identity)}"`);
            say(`department already "${String(cfg.department)}": no change, nothing committed`);
            break;
          }
          const hash = await commit(c, `workflow ${run.id}: ${String(cfg.identity)} moves to ${String(cfg.department)}`, author);
          say(`department updated and committed on ${branch} (commit ${hash.slice(0, 10)})`);
          break;
        }
      }
    }));
  }
}

class Canceled extends Error { constructor() { super('run canceled'); } }
function now(): string { return new Date().toISOString().slice(0, 23).replace('T', ' '); }
async function commit(c: { query(s: string, p?: unknown[]): Promise<unknown> }, message: string, author: string): Promise<string> {
  await c.query("CALL DOLT_ADD('-A')");
  const [r] = (await c.query("CALL DOLT_COMMIT('-m', ?, '--author', ?)", [message, author])) as [{ hash: string }[], unknown];
  return String(r[0].hash);
}

export { hasDataSteps };
