import { BadRequestException, ConflictException, forwardRef, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ApplicationBus } from '../events/application-bus.service.js';
import { WorkflowStore } from './store.js';
import { WorkflowTasksService } from './tasks.js';
import { WorkflowReads } from './reads.js';

const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

export interface IgaItem {
  id: string; tenant: string; campaign_id: string; identity: string; kind: string; action: string;
  payload: Record<string, unknown>; state: string; decided_by: string | null; decided_at: string | null; decision_reason: string | null; run_id: string | null;
}
export interface IgaCampaign {
  id: string; tenant: string; kind: string; name: string; ref: string; status: string;
  scope: Record<string, unknown>; created_by: string; created_at: string; closed_by: string | null; closed_at: string | null; evidence: Record<string, unknown> | null;
}

/**
 * Recertification campaigns (the IGA socle): snapshot a scope on a ref, open one review task per item,
 * record the authenticated decisions (anti-self-approval re-queues), prepare the remediation actions with
 * a fresh snapshot check, close with a complete evidence file. The two meta-store tables live in
 * WorkflowStore (lazy-created on first write like workflow_tasks): a campaign is durable operational
 * state, never versioned directory data.
 */
@Injectable()
export class WorkflowsIgaService {
  constructor(private readonly store: WorkflowStore, @Optional() @Inject(forwardRef(() => WorkflowTasksService)) private readonly tasksRef?: unknown, @Optional() @Inject(forwardRef(() => WorkflowReads)) private readonly readsRef?: unknown, @Optional() private readonly events?: ApplicationBus) {}

  /** Lazily-typed views (forwardRef tokens above: the class bindings are never evaluated at module load). */
  private get tasks(): WorkflowTasksService | undefined { return this.tasksRef as WorkflowTasksService | undefined; }
  private get reads(): WorkflowReads | undefined { return this.readsRef as WorkflowReads | undefined; }

  private emit(tenant: string, type: string, payload: Record<string, string>) { this.events?.emit({ type, tenant, branch: 'main', payload, at: now() }); }

  private async get(tenant: string, id: string): Promise<IgaCampaign> {
    const row = await this.store.igaGetCampaign(tenant, id);
    if (!row) throw new NotFoundException('unknown campaign');
    return row as unknown as IgaCampaign;
  }

  /** Step 1: snapshot the scope on a ref. Items are the users in scope with their current roles. */
  async createCampaign(tenant: string, actor: string, input: { kind?: unknown; name?: unknown; ref?: unknown; scope?: unknown }) {
    if (!this.reads) throw new BadRequestException('IGA campaigns need the reads service (server)');
    const kind = String(input.kind ?? 'user-access');
    if (!['user-access', 'role-membership', 'application-access'].includes(kind)) throw new BadRequestException('kind: user-access, role-membership or application-access');
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 120) throw new BadRequestException('name: 1..120 characters');
    const ref = String(input.ref ?? 'main');
    const scope = (input.scope ?? {}) as { department?: string; role?: string; users?: string[] };
    const listed = Array.isArray(scope.users) && scope.users.length ? scope.users.map(String) : null;
    const users = listed
      ? await Promise.all(listed.map((u) => this.reads!.readUser(tenant, ref, u)))
      : (await this.reads.listUsers(tenant, ref, { department: scope.department, limit: 200 })).users;
    const scoped: { id: string; displayName: string; roles: string[] }[] = [];
    for (const u of users) {
      const roles = 'roles' in u && Array.isArray((u as { roles?: unknown }).roles) ? (u as { roles: string[] }).roles : (await this.reads.listAssignments(ref, { identity: u.id })).assignments.map((a) => a.role);
      if (scope.role && !roles.includes(String(scope.role))) continue;
      scoped.push({ id: u.id, displayName: (u as { displayName?: string }).displayName ?? u.id, roles });
    }
    if (!scoped.length) throw new BadRequestException('the scope selects no user on this ref');
    if (scoped.length > 200) throw new BadRequestException('a campaign is capped at 200 items in this poc (narrow the scope)');
    const id = `iga-${randomBytes(6).toString('hex')}`;
    await this.store.igaPutCampaign(
      { id, tenant, kind, name, ref, status: 'open', scope: scope as Record<string, unknown>, created_by: actor, created_at: now() },
      scoped.map((u) => ({ id: `item-${randomBytes(6).toString('hex')}`, identity: u.id, kind, action: 'review', payload: { roles: u.roles, displayName: u.displayName } })),
    );
    this.emit(tenant, 'iga.campaign-launched', { campaign: id, actor });
    return this.get(tenant, id);
  }

  getCampaign(tenant: string, id: string) { return this.get(tenant, id); }

  async listCampaigns(tenant: string) { return { campaigns: await this.store.igaListCampaigns(tenant) }; }

  async listItems(tenant: string, campaignId: string, state?: string): Promise<{ items: IgaItem[] }> {
    await this.get(tenant, campaignId);
    return { items: (await this.store.igaListItems(tenant, campaignId, state)) as unknown as IgaItem[] };
  }

  /** Step 2: one review task per selected item. Idempotent per item. assignTo: a user id, 'manager' (the item's manager) or 'iga' (the campaign team pool). */
  async openReviewTasks(tenant: string, actor: string, campaignId: string, input: { items?: unknown; assignTo?: unknown; runId?: string }) {
    if (!this.tasks) throw new BadRequestException('review tasks need the tasks service (server)');
    const campaign = await this.get(tenant, campaignId);
    if (campaign.status !== 'open') throw new ConflictException('this campaign is closed');
    const wanted = Array.isArray(input.items) && input.items.length ? new Set(input.items.map(String)) : null;
    const assignTo = String(input.assignTo ?? 'manager');
    const items = (await this.listItems(tenant, campaignId, 'pending')).items.filter((i) => !wanted || wanted.has(i.id));
    const out: { item: string; task: string | null; assignee: string }[] = [];
    for (const i of items) {
      const manager = typeof i.payload?.manager === 'string' ? i.payload.manager : null;
      const assignee = assignTo === 'manager' ? (manager ?? 'iga') : assignTo;
      const t = await this.tasks.request({
        tenant, kind: 'iga-review', title: `Recertify ${i.identity} (${campaign.name})`,
        detail: { campaignId, itemId: i.id, identity: i.identity, roles: i.payload?.roles ?? [], decisions: ['approved', 'denied'] },
        assignee, preventSelfApproval: true, runId: input.runId ?? campaignId, nodeId: i.id,
      });
      out.push({ item: i.id, task: t.id, assignee: t.assignee });
    }
    return { campaign: campaignId, opened: out.length, tasks: out, actor };
  }

  /** Step 3: record a decided review task on its item. Anti-self-approval: a decider reviewing their OWN access re-queues the item to the iga pool and is recorded as a conflict. */
  async recordTaskDecisions(tenant: string, taskIds: string[]) {
    const out: { task: string; item: string | null; recorded: string | null }[] = [];
    for (const taskId of taskIds) {
      const chk = await this.tasks?.check(tenant, taskId);
      if (!chk || chk.state !== 'decided' || !chk.task.decision) { out.push({ task: taskId, item: null, recorded: null }); continue; }
      const detail = chk.task.detail ?? {};
      const campaignId = typeof detail.campaignId === 'string' ? detail.campaignId : null;
      const itemId = typeof detail.itemId === 'string' ? detail.itemId : null;
      if (!campaignId || !itemId) { out.push({ task: taskId, item: null, recorded: null }); continue; }
      const items = (await this.listItems(tenant, campaignId)).items;
      const item = items.find((x) => x.id === itemId);
      if (!item || item.state !== 'pending') { out.push({ task: taskId, item: itemId, recorded: null }); continue; }
      const decision = chk.task.decision === 'approved' ? 'approved' : 'denied';
      if (chk.task.decided_by && chk.task.decided_by === item.identity) {
        await this.store.igaUpdateItem(itemId, { state: 'requeued', decision_reason: `self-review refused for ${chk.task.decided_by}` });
        await this.tasks!.request({ tenant, kind: 'iga-review', title: `Recertify ${item.identity} (self-review requeued)`, detail: { ...detail, requeued: true }, assignee: 'iga', preventSelfApproval: true, runId: chk.task.run_id ?? `${campaignId}-requeue`, nodeId: `${itemId}-requeue` });
        this.emit(tenant, 'iga.decision-recorded', { campaign: campaignId, subject: item.identity, role: '*', decision: 'requeued-self-review', actor: chk.task.decided_by });
        out.push({ task: taskId, item: itemId, recorded: 'requeued' });
        continue;
      }
      await this.store.igaUpdateItem(itemId, { state: decision, decided_by: chk.task.decided_by, decided_at: now(), decision_reason: chk.task.justification, run_id: chk.task.run_id });
      this.emit(tenant, 'iga.decision-recorded', { campaign: campaignId, subject: item.identity, role: (item.payload?.roles as string[] | undefined)?.join(',') ?? '*', decision, actor: chk.task.decided_by ?? 'unknown' });
      out.push({ task: taskId, item: itemId, recorded: decision });
    }
    return { recorded: out };
  }

  /** Step 4: for every denied item, the remediation actions (revoke the reviewed roles), after a FRESH snapshot check on the campaign ref: roles changed since the campaign snapshot = conflict, no action prepared. */
  async prepareRemediation(tenant: string, actor: string, campaignId: string, input: { items?: unknown }) {
    if (!this.reads) throw new BadRequestException('remediation needs the reads service (server)');
    const campaign = await this.get(tenant, campaignId);
    if (campaign.status !== 'open') throw new ConflictException('this campaign is closed');
    const wanted = Array.isArray(input.items) && input.items.length ? new Set(input.items.map(String)) : null;
    const denied = (await this.listItems(tenant, campaignId, 'denied')).items.filter((i) => !wanted || wanted.has(i.id));
    const out: { item: string; identity: string; actions?: { type: string; identity: string; role: string }[]; conflict?: string }[] = [];
    for (const i of denied) {
      const snapshotRoles = (i.payload?.roles as string[] | undefined) ?? [];
      const current = await this.reads.listAssignments(campaign.ref, { identity: i.identity });
      const currentRoles = current.assignments.map((a) => a.role);
      const changed = snapshotRoles.some((r) => !currentRoles.includes(r)) || currentRoles.some((r) => !snapshotRoles.includes(r));
      if (changed) {
        out.push({ item: i.id, identity: i.identity, conflict: `roles changed since the snapshot (then: ${snapshotRoles.join(',') || 'none'}; now: ${currentRoles.join(',') || 'none'}): review again before remediating` });
        this.emit(tenant, 'iga.remediation-resolved', { campaign: campaignId, subject: i.identity, role: snapshotRoles.join(',') || '*', result: 'conflict' });
        continue;
      }
      const actions = snapshotRoles.map((role) => ({ type: 'revoke-role', identity: i.identity, role }));
      await this.store.igaUpdateItem(i.id, { state: 'remediation-prepared', payload: { ...i.payload, remediation: actions, remediatedBy: null } });
      this.emit(tenant, 'iga.remediation-resolved', { campaign: campaignId, subject: i.identity, role: snapshotRoles.join(',') || '*', result: 'prepared' });
      out.push({ item: i.id, identity: i.identity, actions });
    }
    return { campaign: campaignId, remediation: out, actor };
  }

  /** Step 5: close with the complete evidence file (scope, items, decisions, remediation, refs). */
  async close(tenant: string, actor: string, campaignId: string) {
    const campaign = await this.get(tenant, campaignId);
    if (campaign.status !== 'open') throw new ConflictException('this campaign is already closed');
    const items = (await this.listItems(tenant, campaignId)).items;
    const pending = items.filter((i) => i.state === 'pending' || i.state === 'requeued');
    const evidence: Record<string, unknown> = {
      campaign: campaign.id, kind: campaign.kind, name: campaign.name, ref: campaign.ref, scope: campaign.scope,
      createdBy: campaign.created_by, createdAt: campaign.created_at, closedBy: actor, closedAt: now(),
      totals: { items: items.length, approved: items.filter((i) => i.state === 'approved').length, denied: items.filter((i) => i.state === 'denied').length, remediationPrepared: items.filter((i) => i.state === 'remediation-prepared').length, remediated: items.filter((i) => i.state === 'remediated').length, undecided: pending.length },
      items: items.map((i) => ({ identity: i.identity, roles: i.payload?.roles ?? [], state: i.state, decidedBy: i.decided_by, decidedAt: i.decided_at, reason: i.decision_reason, remediation: i.payload?.remediation ?? null })),
      digest: null,
    };
    evidence.digest = createHash('sha256').update(JSON.stringify({ ...evidence, digest: null })).digest('hex');
    await this.store.igaCloseCampaign(campaignId, actor, now(), evidence);
    this.emit(tenant, 'iga.campaign-closed', { campaign: campaignId, actor });
    return { campaign: campaignId, status: 'closed', evidence };
  }
}
