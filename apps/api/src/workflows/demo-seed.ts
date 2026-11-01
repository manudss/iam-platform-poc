import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { validateGraph, WfTrigger } from './model.js';
import { DefinitionRow, WorkflowStore } from './store.js';

/**
 * DEMO ONLY, opt-in with IAM_DEMO_DATA_SEED=1 (the hosted demo sets it): three triggered workflow
 * definitions so the feature is alive out of the box - a joiner, a mover and a leaver scenario that
 * start by themselves on application events. Idempotent (fixed ids, never overwritten).
 */
const SEEDS: { id: string; name: string; description: string; trigger: WfTrigger; nodes: { id: string; type: 'assign-role' | 'revoke-role' | 'notify'; name: string; config: Record<string, unknown> }[]; edges: { from: string; to: string }[] }[] = [
  {
    id: 'wf-joiner', name: 'Joiner: new hire baseline', description: 'Starts when a user is created: grants the employee baseline role (real, on the run branch) and informs the manager (simulated).',
    trigger: { event: 'user.created' },
    nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant the employee baseline', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'manager-of:{{event.subject}}', message: '{{event.displayName}} joined {{event.department}}: baseline access granted, pending review' } },
    ],
    edges: [{ from: 'grant', to: 'tell' }],
  },
  {
    id: 'wf-mover', name: 'Mover: arrival in Finance', description: 'Starts when a user moves INTO the finance department: grants the accountant role (real) and informs the finance manager (simulated).',
    trigger: { event: 'user.department-changed', match: { to: 'finance' } },
    nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant accountant for finance', config: { identity: '{{event.subject}}', role: 'accountant' } },
      { id: 'tell', type: 'notify', name: 'Inform the finance manager (simulated)', config: { recipient: 'finance-manager', message: '{{event.subject}} moved from {{event.from}} to finance: accountant granted, pending review' } },
    ],
    edges: [{ from: 'grant', to: 'tell' }],
  },
  {
    id: 'wf-leaver', name: 'Leaver: baseline access removed', description: 'Starts when an account is disabled: revokes the employee baseline (real) and informs security (simulated).',
    trigger: { event: 'user.disabled' },
    nodes: [
      { id: 'revoke', type: 'revoke-role', name: 'Revoke the employee baseline', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'tell', type: 'notify', name: 'Inform security (simulated)', config: { recipient: 'security', message: '{{event.subject}} disabled: baseline access removed, review remaining roles' } },
    ],
    edges: [{ from: 'revoke', to: 'tell' }],
  },
];

@Injectable()
export class WorkflowDemoSeed implements OnApplicationBootstrap {
  private readonly log = new Logger('workflow-demo-seed');
  constructor(private readonly store: WorkflowStore) {}
  async onApplicationBootstrap() {
    if (process.env.IAM_DEMO_DATA_SEED !== '1') return;
    const tenant = process.env.IAM_AUTHN_DEMO_SEED_TENANT || 'acme-demo';
    const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
    for (const s of SEEDS) {
      try {
        if (await this.store.getDefinition(tenant, s.id)) continue;
        const { graph } = validateGraph({ nodes: s.nodes, edges: s.edges });
        const def: DefinitionRow = { id: s.id, tenant, name: s.name, description: s.description, graph, trigger: s.trigger, created_by: 'demo-seed', created_at: now(), updated_at: now() };
        await this.store.putDefinition(def);
        this.log.log(`seeded triggered workflow "${s.name}" (${s.trigger.event})`);
      } catch (e) { this.log.warn(`seed ${s.id} skipped: ${(e as Error).message}`); }
    }
  }
}
