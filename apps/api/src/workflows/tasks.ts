import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ApplicationBus } from '../events/application-bus.service.js';
// Value import used only inside the lazy getter below (never at module scope): no load-order cycle.
import { WorkflowEngine } from './engine.js';
import { TaskRow, WorkflowStore } from './store.js';

const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const ts = (ms: number) => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');

export interface TaskRequest {
  tenant: string; kind: string; title: string; detail?: Record<string, unknown>;
  assignee: string; dueInSeconds?: number; escalateTo?: string; preventSelfApproval?: boolean;
  runId: string; nodeId: string;
}
export interface TaskCheck { state: 'open' | 'decided'; task: TaskRow }

/**
 * Durable human tasks for workflows (P0 "approvals and human tasks"): create a task, name a decider,
 * wait for the decision, remind/escalate on the deadline, resume the run. A decision is authenticated
 * (the caller's subject), justified when required, and the anti-self-approval policy refuses a run
 * starter deciding their own request. Tasks live in the meta store (durable, unversioned): a restart
 * loses neither a task nor its deadline, and replaying an event never duplicates a decision.
 */
@Injectable()
export class WorkflowTasksService {
  constructor(private readonly store: WorkflowStore, @Optional() private readonly events?: ApplicationBus, @Optional() private readonly modules?: ModuleRef) {}

  private readonly log = new Logger('workflow-tasks');
  private engineWarned = false;
  /** The engine, resolved lazily (module wiring order): absent in unit tests and minimal servers.
   *  A resolution failure on a wired server is logged once, never swallowed silently. */
  private engine(): WorkflowEngine | undefined {
    if (!this.modules) return undefined;
    try { return this.modules.get(WorkflowEngine, { strict: false }); }
    catch (e) { if (!this.engineWarned) { this.engineWarned = true; this.log.warn(`workflow engine unresolved: task decisions cannot resume runs (${(e as Error).message})`); } return undefined; }
  }
  private kick(runId: string | null) {
    if (!runId) return;
    const e = this.engine();
    if (e) e.kick(runId);
    else if (this.modules && !this.engineWarned) { this.engineWarned = true; this.log.warn(`run ${runId} not resumed: no workflow engine on this server`); }
  }
  /** The members of a named decider pool ('admin' or 'iga'): every member may decide, not just the first. */
  poolMembers(name: string): string[] {
    if (name === 'iga') { const pool = (process.env.IAM_API_IGA_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean); return pool.length ? pool : this.admins(); }
    if (name === 'admin') return this.admins();
    return [];
  }

  private emit(tenant: string, type: string, payload: Record<string, string>) {
    this.events?.emit({ type, tenant, branch: 'main', payload, at: now() });
  }

  /** The admins allowed to decide or delegate ANY task (same subject list as the admin capability). */
  private admins(): string[] { return (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean); }
  isAdmin(sub: unknown): boolean { return typeof sub === 'string' && this.admins().includes(sub); }

  /** A decider name is never a magic literal: 'admin' resolves to the administrator subjects (the same
   *  list the admin capability uses), 'iga' to the campaign pool (IAM_API_IGA_SUBJECTS, fallback admins).
   *  Anything else must be a concrete user id. */
  resolveAssignee(name: string): string {
    const n = String(name ?? '').trim();
    if (n === 'admin' || n === 'iga') {
      const pool = n === 'iga' ? (process.env.IAM_API_IGA_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [];
      const resolved = (pool.length ? pool : this.admins())[0];
      if (!resolved) throw new BadRequestException(`the "${n}" decider pool is empty on this server (no ${n === 'iga' ? 'IAM_API_IGA_SUBJECTS or IAM_API_ADMIN_SUBJECTS' : 'IAM_API_ADMIN_SUBJECTS'} subject)`);
      return resolved;
    }
    if (!/^[a-z0-9][a-z0-9._@-]{0,63}$/.test(n)) throw new BadRequestException('assignee: a user id, "admin" or "iga"');
    return n;
  }

  /** Creates (or returns, idempotent by run step) the task a waiting block asks for. */
  async request(a: TaskRequest): Promise<TaskRow> {
    // A re-run of the same waiting step reuses its task: never a second task for the same run step+kind.
    const existing = (await this.store.listTasks(a.tenant, { runId: a.runId })).find((t) => t.node_id === a.nodeId && t.kind === a.kind && t.status !== 'canceled');
    if (existing) return existing;
    const id = `task-${randomBytes(6).toString('hex')}`;
    const t: TaskRow = {
      id, tenant: a.tenant, kind: a.kind, title: a.title, detail: a.detail ?? {},
      assignee: a.assignee, delegated_to: null, status: 'open', decision: null, justification: null, decided_by: null,
      run_id: a.runId, node_id: a.nodeId, prevent_self: !!a.preventSelfApproval,
      created_at: now(), due_at: a.dueInSeconds ? ts(Date.now() + a.dueInSeconds * 1000) : null, reminded_at: null, decided_at: null,
    };
    if (a.escalateTo) t.detail = { ...t.detail, escalateTo: a.escalateTo };
    if (t.assignee === 'admin' || t.assignee === 'iga') t.detail = { ...t.detail, pool: t.assignee };
    t.assignee = this.resolveAssignee(t.assignee);
    if (t.assignee === t.detail?.identity || t.assignee === t.detail?.subject) {
      // The beneficiary never receives their own certification task: the pool takes it instead.
      const pool = (process.env.IAM_API_IGA_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const fallback = [...pool, ...this.admins()].find((x) => x !== t.assignee);
      if (fallback) t.assignee = fallback;
    }
    const saved = await this.store.putTask(t);
    this.emit(a.tenant, 'workflow.task-assigned', { task: saved.id, kind: saved.kind, title: saved.title, assignee: saved.assignee, actor: `workflow:${a.runId}` });
    return saved;
  }

  /** What a resumed waiting block reads. Overdue handling lives here so a re-kick escalates exactly once. */
  async check(tenant: string, taskId: string): Promise<TaskCheck> {
    const t = await this.store.getTask(taskId);
    if (!t || t.tenant !== tenant) return { state: 'decided', task: { id: taskId } as TaskRow }; // unknown = terminal (canceled tasks never resume a run silently: the block reads the missing decision and fails honestly)
    if (t.status === 'decided') return { state: 'decided', task: t };
    if (t.status === 'canceled') return { state: 'decided', task: t };
    return { state: 'open', task: t };
  }

  /** Durable single use of a decided task: the first (run:node) consumer wins, the same consumer asking again is idempotent, any other is refused. */
  async consume(tenant: string, taskId: string, consumer: string): Promise<void> {
    const t = await this.store.getTask(taskId);
    if (!t || t.tenant !== tenant) throw new NotFoundException('unknown task');
    if (t.status !== 'decided') throw new ConflictException(`this task is ${t.status}, not decided`);
    const r = await this.store.consumeTask(taskId, String(consumer).slice(0, 120));
    if (r.applied) throw new ConflictException('this approval already produced its effect: it is burned, a new approval is required');
    if (!r.ok) throw new ConflictException('this approval was already consumed by another step');
  }
  /** Records the effect of the consumer (revision written). Refused for any other consumer or a second time. */
  async markApplied(tenant: string, taskId: string, consumer: string, revision: string): Promise<void> {
    const t = await this.store.getTask(taskId);
    if (!t || t.tenant !== tenant) throw new NotFoundException('unknown task');
    if (!(await this.store.markTaskApplied(taskId, String(consumer).slice(0, 120), String(revision).slice(0, 80)))) throw new ConflictException('the effect of this approval could not be recorded for this consumer');
  }

  /** Decision by an authenticated person. Returns the decided task and kicks the waiting run. */
  async decide(tenant: string, id: string, actor: string, decision: unknown, justification: unknown): Promise<TaskRow> {
    const t = await this.store.getTask(id);
    if (!t || t.tenant !== tenant) throw new NotFoundException('unknown task');
    if (t.status !== 'open') throw new ConflictException(`this task is already ${t.status}`);
    const choices = Array.isArray(t.detail?.decisions) && (t.detail.decisions as unknown[]).length ? (t.detail.decisions as unknown[]).map(String) : ['approved', 'refused'];
    const d = String(decision ?? '');
    if (!choices.includes(d)) throw new BadRequestException(`decision: one of ${choices.join(', ')}`);
    const just = String(justification ?? '').slice(0, 1000);
    if (d !== 'approved' && !just.trim()) throw new BadRequestException('a justification is required for a refusal');
    if (t.detail?.requireJustification === true && !just.trim()) throw new BadRequestException('a justification is required for every decision on this task');
    if (t.prevent_self) {
      // Anti-self-approval follows the CHAIN of starter runs: a task created by a sub-workflow is
      // refused to the person who started its ancestor run too (bounded walk, workflow:<runId> links).
      let run = t.run_id ? await this.store.getRunById(t.run_id) : null;
      for (let depth = 0; run && depth < 10; depth++) {
        if (run.started_by === actor) throw new ForbiddenException('anti-self-approval: the person who started this workflow cannot decide its approval task');
        if (!run.started_by.startsWith('workflow:')) break;
        run = await this.store.getRunById(run.started_by.slice('workflow:'.length));
      }
      // Nor a beneficiary of the request (a certification, an access grant, a closure exception covering
      // their own unresolved items): the run starter check above covers the initiator, this one the subjects.
      const beneficiaries = new Set<string>([t.detail?.identity, t.detail?.subject].filter((x) => typeof x === 'string') as string[]);
      if (Array.isArray(t.detail?.unresolved)) for (const u of t.detail.unresolved as { identity?: unknown }[]) if (typeof u?.identity === 'string') beneficiaries.add(u.identity);
      if (beneficiaries.has(actor)) throw new ForbiddenException('anti-self-approval: the beneficiary of a request cannot decide their own review');
    }
    const isAdmin = this.isAdmin(actor);
    const pool = typeof t.detail?.pool === 'string' ? this.poolMembers(t.detail.pool) : [];
    const saved = isAdmin || pool.includes(actor)
      ? await this.store.decideTaskAs(id, actor, d, just || null, now())
      : await this.store.decideTask(id, actor, d, just || null, now());
    if (!saved) {
      const again = await this.store.getTask(id);
      if (again && again.status === 'decided') throw new ConflictException(`this task was just decided by ${again.decided_by}`);
      throw new ForbiddenException('only the assigned decider, a member of the decider pool, or their delegate can decide this task');
    }
    this.emit(tenant, 'workflow.task-decided', { task: id, kind: t.kind, decision: d, actor });
    this.kick(saved.run_id);
    return saved;
  }

  /** Delegation: the current decider (or an admin) names a replacement decider. */
  async delegate(tenant: string, id: string, actor: string, to: unknown): Promise<TaskRow> {
    const t = await this.store.getTask(id);
    if (!t || t.tenant !== tenant) throw new NotFoundException('unknown task');
    if (t.status !== 'open') throw new ConflictException(`this task is already ${t.status}`);
    const rawTo = String(to ?? '').trim();
    const target = this.resolveAssignee(rawTo);
    const pool = typeof t.detail?.pool === 'string' ? this.poolMembers(t.detail.pool) : [];
    if (!this.isAdmin(actor) && !pool.includes(actor) && t.assignee !== actor && t.delegated_to !== actor) throw new ForbiddenException('only the assigned decider (or a pool member) can delegate this task');
    if (rawTo === 'admin' || rawTo === 'iga') await this.store.patchTaskDetail(id, { pool: rawTo }); else await this.store.patchTaskDetail(id, { pool: null });
    const saved = await this.store.delegateTask(id, target, t.due_at ?? now());
    if (!saved) throw new ConflictException('this task is no longer open');
    this.emit(tenant, 'workflow.task-assigned', { task: id, kind: t.kind, title: t.title, assignee: target, actor });
    return saved;
  }

  /** The visible inbox: OPEN tasks first (status=all widens). Own tasks for everyone, everything for an
   * admin with scope=all. "Own" includes the tasks decidable through a pool the actor belongs to: pool
   * members CAN decide them (decide() checks membership), so they must see them. truncated reports the
   * store's 200-row cap instead of silently hiding older tasks. */
  async inbox(tenant: string, actor: string, scope: unknown, status: unknown): Promise<{ tasks: TaskRow[]; truncated: boolean }> {
    const all = scope === 'all' && this.isAdmin(actor);
    const st = ['open', 'decided', 'canceled'].includes(String(status)) ? String(status) : String(status) === 'all' ? undefined : 'open';
    const filter = st ? { status: st } : {};
    const tasks = await this.store.listTasks(tenant, all ? filter : { ...filter, assignee: actor });
    let truncated = tasks.length >= 200;
    if (!all) {
      const mine = new Set(tasks.map((t) => t.id));
      const pools = ['admin', 'iga'].filter((p) => this.poolMembers(p).includes(actor));
      if (pools.length) {
        const rest = await this.store.listTasks(tenant, filter);
        truncated = truncated || rest.length >= 200;
        for (const t of rest) if (!mine.has(t.id) && typeof t.detail?.pool === 'string' && pools.includes(t.detail.pool)) { tasks.push(t); mine.add(t.id); }
      }
    }
    return { tasks, truncated };
  }

  /** Deadline scan (called by the cron tick and on resume checks): overdue tasks escalate once. */
  async scanOverdue(): Promise<number> {
    const open = await this.store.listDueTasks(now());
    let n = 0;
    for (const t of open.filter((x) => x.status === 'open')) {
      if (!t.due_at || Date.parse(t.due_at) > Date.now()) continue;
      // A rescan task (publication watch) re-kicks its run on every tick while due: the block re-reads the
      // real external state. Reminder/escalation still happen exactly once.
      const rescan = t.detail?.rescan === true;
      if (t.reminded_at && !rescan) continue;
      const escalateTo = typeof t.detail?.escalateTo === 'string' ? t.detail.escalateTo : null;
      let resolved: string | null = null;
      if (escalateTo && !t.reminded_at) {
        try { resolved = this.resolveAssignee(escalateTo); if (escalateTo === 'admin' || escalateTo === 'iga') await this.store.patchTaskDetail(t.id, { pool: escalateTo }); }
        catch (e) { this.log.warn(`task ${t.id}: escalation target "${escalateTo}" rejected (${(e as Error).message}): the task stays with ${t.assignee}`); }
      }
      if (resolved) await this.store.delegateTask(t.id, resolved, t.due_at);
      if (!t.reminded_at) {
        await this.store.markTaskReminded(t.id, now());
        this.emit(t.tenant, 'workflow.task-overdue', { task: t.id, kind: t.kind, assignee: resolved ?? t.assignee });
      }
      this.kick(t.run_id); // a waiting block re-evaluates (and keeps waiting on the escalated task)
      n++;
    }
    return n;
  }

  /** The system settles a wait that external state made moot (a pull request merged or closed BEFORE the
   *  approval was decided): canceled with the reason recorded - the audit row stays, nothing is destroyed. */
  async settleSystem(tenant: string, taskId: string, actor: string, note: unknown): Promise<boolean> {
    const t = await this.store.getTask(taskId);
    if (!t || t.tenant !== tenant || t.status !== 'open') return false;
    const ok = await this.store.settleTask(taskId, actor, String(note ?? '').slice(0, 500), now());
    if (ok) this.emit(tenant, 'workflow.task-canceled', { task: taskId, kind: t.kind, actor });
    return ok;
  }

  /** A canceled run cancels its open tasks: no orphan approvals that can never resume anything. */
  async cancelForRun(tenant: string, runId: string): Promise<number> {
    const t = await this.store.getRun(tenant, runId);
    if (!t) return 0;
    return this.store.cancelTasksForRun(runId, now());
  }
}
