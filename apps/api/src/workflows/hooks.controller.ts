import { Body, Controller, NotFoundException, Param, Post, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { branchContext, workspaceMode } from '../workspace/context.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { WorkflowStore } from './store.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Public HTTP webhook trigger (contributed by the workflow-connectors plugin, event http.webhook-received):
 *   POST /tenants/:tenant/workflow-hooks/:definitionId/:token   with a JSON body.
 * No session: the per-workflow token in the path IS the credential (chosen in the trigger config, 12+ chars,
 * compared in constant time). The body becomes the event payload: every top-level key with a scalar value is
 * usable as {{event.<key>}} in the workflow steps. Optional "_dedupe": a stable caller id - the same value
 * never starts a second run.
 */
@Controller('tenants/:tenant/workflow-hooks')
export class WorkflowHooksController {
  constructor(private readonly store: WorkflowStore, private readonly wf: WorkflowsService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}

  @Post(':definition/:token')
  async fire(@Param('tenant') tenant: string, @Param('definition') definition: string, @Param('token') token: string, @Body() body: unknown) {
    return branchContext.run({ branch: this.store.liveRef }, async () => {
    const registry = workspaceMode() && this.branches ? await this.branches.get(this.store.liveRef) : this.reg;
    if (!registry.isActive(tenant, 'workflow-connectors') || !registry.isActive(tenant, 'workflows-iga'))
      throw new NotFoundException('no such webhook'); // provider disabled: say nothing
    const d = await this.store.getDefinition(tenant, definition, this.store.liveRef);
    if (!d || d.trigger?.event !== 'http.webhook-received') throw new NotFoundException('no such webhook');
    const want = Buffer.from(String(d.trigger.config?.token ?? ''));
    const got = Buffer.from(String(token ?? ''));
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw new UnauthorizedException('bad webhook token');

    const payload: Record<string, string> = {};
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (k === '_dedupe' || !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) continue;
        payload[k] = (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')).slice(0, 500);
        if (Object.keys(payload).length >= 40) break;
      }
    }
    const dedupe = body && typeof body === 'object' ? String((body as Record<string, unknown>)._dedupe ?? '') : '';
    const eventId = dedupe ? createHash('sha256').update(JSON.stringify(['webhook', tenant, d.id, dedupe])).digest('hex').slice(0, 32) : undefined;
    const view = await this.wf.start(tenant, d.id, 'webhook', { branch: this.store.liveRef, payload, eventId });
    return { run: view.run.id, status: view.run.status, deduplicated: !!eventId };
    });
  }
}
