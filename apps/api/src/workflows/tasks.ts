import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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

  /** The engine, resolved lazily (module wiring order): absent in unit tests and minimal servers. */
  private engine(): WorkflowEngine | undefined {
    try { return this.modules?.get(WorkflowEngine, { strict: false }); } catch { return undefined; }
  }

  private emit(tenant: string, type: string, payload: Record<string, string>) {
    this.events?.emit({ type, tenant, branch: 'main', payload, at: now() });
  }

  /** The admins allowed to decide or delegate ANY task (same subject list as the admin capability). */
  private admins(): string[] { return (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean); }
  isAdmin(sub: unknown): boolean { return typeof sub === 'string' && this.admins().includes(sub); }

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
    if (t.prevent_self) {
      // Anti-self-approval follows the CHAIN of starter runs: a task created by a sub-workflow is
      // refused to the person who started its ancestor run too (bounded walk, workflow:<runId> links).
      let run = t.run_id ? await this.store.getRunById(t.run_id) : null;
      for (let depth = 0; run && depth < 10; depth++) {
        if (run.started_by === actor) throw new ForbiddenException('anti-self-approval: the person who started this workflow cannot decide its approval task');
        if (!run.started_by.startsWith('workflow:')) break;
        run = await this.store.getRunById(run.started_by.slice('workflow:'.length));
      }
    }
    const isAdmin = this.isAdmin(actor);
    const saved = isAdmin
      ? await this.store.decideTaskAs(id, actor, d, just || null, now())
      : await this.store.decideTask(id, actor, d, just || null, now());
    if (!saved) {
      const again = await this.store.getTask(id);
      if (again && again.status === 'decided') throw new ConflictException(`this task was just decided by ${again.decided_by}`);
      throw new ForbiddenException('only the assigned decider (or their delegate) can decide this task');
    }
    this.emit(tenant, 'workflow.task-decided', { task: id, kind: t.kind, decision: d, actor });
    if (saved.run_id) this.engine()?.kick(saved.run_id);
    return saved;
  }

  /** Delegation: the current decider (or an admin) names a replacement decider. */
  async delegate(tenant: string, id: string, actor: string, to: unknown): Promise<TaskRow> {
    const t = await this.store.getTask(id);
    if (!t || t.tenant !== tenant) throw new NotFoundException('unknown task');
    if (t.status !== 'open') throw new ConflictException(`this task is already ${t.status}`);
    const target = String(to ?? '').trim();
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(target)) throw new BadRequestException('delegate to a user id (lowercase, digits, dots, hyphens)');
    if (!this.isAdmin(actor) && t.assignee !== actor && t.delegated_to !== actor) throw new ForbiddenException('only the assigned decider can delegate this task');
    const saved = await this.store.delegateTask(id, target, t.due_at ?? now());
    if (!saved) throw new ConflictException('this task is no longer open');
    this.emit(tenant, 'workflow.task-assigned', { task: id, kind: t.kind, title: t.title, assignee: target, actor });
    return saved;
  }

  /** The visible inbox: own tasks for everyone, everything for an admin with scope=all. */
  async inbox(tenant: string, actor: string, scope: unknown): Promise<{ tasks: TaskRow[] }> {
    const all = scope === 'all' && this.isAdmin(actor);
    const tasks = await this.store.listTasks(tenant, all ? {} : { assignee: actor });
    return { tasks };
  }

  /** Deadline scan (called by the cron tick and on resume checks): overdue tasks escalate once. */
  async scanOverdue(): Promise<number> {
    const open = await this.store.listDueTasks(now());
    let n = 0;
    for (const t of open.filter((x) => x.status === 'open')) {
      if (!t.due_at || Date.parse(t.due_at) > Date.now() || t.reminded_at) continue;
      const escalateTo = typeof t.detail?.escalateTo === 'string' ? t.detail.escalateTo : null;
      if (escalateTo) await this.store.delegateTask(t.id, escalateTo, t.due_at);
      await this.store.markTaskReminded(t.id, now());
      this.emit(t.tenant, 'workflow.task-overdue', { task: t.id, kind: t.kind, assignee: escalateTo ?? t.assignee });
      if (t.run_id) this.engine()?.kick(t.run_id); // a waiting block re-evaluates (and keeps waiting on the escalated task)
      n++;
    }
    return n;
  }

  /** A canceled run cancels its open tasks: no orphan approvals that can never resume anything. */
  async cancelForRun(tenant: string, runId: string): Promise<number> {
    const t = await this.store.getRun(tenant, runId);
    if (!t) return 0;
    return this.store.cancelTasksForRun(runId, now());
  }
}
