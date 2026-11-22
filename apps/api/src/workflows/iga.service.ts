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

  /** The review tasks of a campaign (dedicated query, no inbox cap). */
  async reviewTasks(tenant: string, campaignId: string) {
    await this.get(tenant, campaignId);
    return { tasks: await this.store.listTasksByCampaign(tenant, campaignId) };
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
      // pending: first review; requeued: the review after a refused self-review. Anything else is done.
      if (!item || (item.state !== 'pending' && item.state !== 'requeued')) { out.push({ task: taskId, item: itemId, recorded: null }); continue; }
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
      if (!Array.isArray(i.payload?.roles)) {
        out.push({ item: i.id, identity: i.identity, conflict: 'no valid role snapshot (payload.roles missing or malformed): review again before remediating' });
        this.emit(tenant, 'iga.remediation-resolved', { campaign: campaignId, subject: i.identity, role: '*', result: 'conflict' });
        continue;
      }
      const snapshotRoles = i.payload.roles as string[];
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

  /** Step 4b: the remediation of an item was APPLIED (through a controlled change, e.g. the run branch of
   *  the calling workflow): record the application and its proof. Never called by a decision alone. */
  /** A remediation is 'remediated' only when the revoked roles are EFFECTIVELY gone on the campaign ref
   *  (published): a completed run id is required as proof, and the live assignments are re-read. A revocation
   *  sitting on an unmerged run branch is reported as such, never as applied. */
  async markRemediated(tenant: string, actor: string, campaignId: string, itemId: string, proof: { runId?: unknown; note?: unknown }) {
    const campaign = await this.get(tenant, campaignId);
    if (campaign.status !== 'open') throw new ConflictException('this campaign is closed');
    const items = (await this.listItems(tenant, campaignId)).items;
    const item = items.find((x) => x.id === itemId || x.identity === itemId);
    if (!item) throw new NotFoundException('unknown item');
    if (item.state !== 'remediation-prepared') throw new ConflictException(`this item is ${item.state}: prepare its remediation first`);
    const runId = String(proof.runId ?? '').trim();
    if (!runId) throw new BadRequestException('remediation proof: the id of the workflow run that applied the remediation is required (a note alone never suffices)');
    const run = await this.store.getRun(tenant, runId);
    if (!run) throw new BadRequestException(`remediation proof: unknown run "${runId}" for this tenant`);
    // The proof run is normally a COMPLETED remediation run. The run currently executing this block may cite
    // itself: the effective-assignment check below is the real gate in both cases.
    const selfProof = actor === `workflow:${runId}`;
    if (run.status !== 'completed' && !selfProof) throw new ConflictException(`remediation proof: run ${runId} is ${run.status}, not completed`);
    // The snapshot roles MUST be a real array recorded by a validated snapshot: a missing or malformed
    // payload means the item is corrupt (or hand-written), never "nothing to verify" - that would fail open.
    if (!Array.isArray(item.payload?.roles)) throw new ConflictException('this item has no valid role snapshot (payload.roles missing or malformed): review it again before marking anything remediated');
    const roles = item.payload.roles as string[];
    // A denied item whose snapshot held NO role (an explicitly empty array) has nothing to revoke: the
    // remediation is vacuously effective (the denial and its reason stay on the evidence file). Refusing
    // it would strand the item in remediation-prepared forever and make the campaign impossible to close.
    if (roles.length) {
    if (!Array.isArray(item.payload?.remediation) || !(item.payload.remediation as unknown[]).length) throw new ConflictException('no remediation actions prepared for this item: run iga-prepare-remediation first');
    if (!run.branch) throw new BadRequestException(`remediation proof: run ${runId} had no data branch (simulated steps only): it cannot have applied anything`);
    {
      if (!this.reads) throw new BadRequestException('the remediation cannot be verified on this server (reads unavailable): refusing to mark remediated on trust');
      const onRef = (await this.reads.listAssignments(campaign.ref, { identity: item.identity })).assignments.map((a) => a.role).filter((r) => roles.includes(r));
      if (onRef.length) {
        let onBranch = onRef;
        if (run.branch) { try { onBranch = (await this.reads.listAssignments(run.branch, { identity: item.identity })).assignments.map((a) => a.role).filter((r) => roles.includes(r)); } catch { onBranch = onRef; } }
        if (!onBranch.length) throw new ConflictException(`the role(s) ${onRef.join(', ')} are revoked on run branch ${run.branch} but that branch is not published to ${campaign.ref}: publish it, then mark remediated`);
        throw new ConflictException(`the role(s) ${onRef.join(', ')} are still assigned to ${item.identity} on ${campaign.ref}: the remediation is not effective`);
      }
    }
    }
    await this.store.igaUpdateItem(item.id, { state: 'remediated', payload: { ...item.payload, remediatedBy: actor, remediatedAt: now(), remediationProof: { runId, verifiedOn: campaign.ref, note: String(proof.note ?? '').slice(0, 500) } } });
    this.emit(tenant, 'iga.remediation-resolved', { campaign: campaignId, subject: item.identity, role: (item.payload?.roles as string[] | undefined)?.join(',') ?? '*', result: 'remediated' });
    return { item: itemId, state: 'remediated' };
  }

  /** Step 5: close with the complete evidence file (scope, items, decisions, remediation, refs).
   *  Strict: an undecided item, or a denied item without applied remediation, blocks the closure unless
   *  allowIncomplete records it explicitly in the evidence. */
  /** Strict close. An incomplete campaign closes ONLY through a traced human exception (an authorized
   *  decider approved it with a justification): never through a workflow config flag. */
  async close(tenant: string, actor: string, campaignId: string, input: { exception?: { by?: unknown; justification?: unknown; approvedUnresolved?: unknown } } = {}) {
    const campaign = await this.get(tenant, campaignId);
    if (campaign.status !== 'open') throw new ConflictException('this campaign is already closed');
    const items = (await this.listItems(tenant, campaignId)).items;
    const pending = items.filter((i) => i.state === 'pending' || i.state === 'requeued');
    const unremediated = items.filter((i) => i.state === 'denied' || i.state === 'remediation-prepared');
    let incomplete: Record<string, unknown> | null = null;
    if (pending.length || unremediated.length) {
      const by = String(input.exception?.by ?? '').trim();
      const justification = String(input.exception?.justification ?? '').trim();
      if (!by || by.startsWith('workflow:') || !justification) {
        throw new ConflictException(`this campaign is not complete: ${pending.length} undecided item(s), ${unremediated.length} denied item(s) without applied remediation. An incomplete closure needs a human exception (an authorized decider, with a justification), never a config flag.`);
      }
      // The exception covers EXACTLY the unresolved set the decider approved: an item that became
      // unresolved AFTER the decision (a requeue, a new denial) is not covered - re-approve or resolve it.
      const approved = new Set(Array.isArray(input.exception?.approvedUnresolved) ? (input.exception!.approvedUnresolved as unknown[]).map(String) : []);
      const current = [...pending, ...unremediated].map((i) => i.id);
      const drift = current.filter((id) => !approved.has(id));
      if (drift.length) throw new ConflictException(`the unresolved items changed since the exception was approved (${drift.join(', ')} not covered): resolve them or request a new exception`);
      incomplete = { authorizedBy: by, justification: justification.slice(0, 1000),
        undecided: pending.map((i) => ({ item: i.id, identity: i.identity, state: i.state })),
        unremediated: unremediated.map((i) => ({ item: i.id, identity: i.identity, state: i.state })) };
    }
    const evidence: Record<string, unknown> = { incompleteClosure: incomplete,
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
