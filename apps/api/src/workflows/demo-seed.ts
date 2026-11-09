import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { validateGraph, WfTrigger } from './model.js';
import { DefinitionRow, WorkflowStore } from './store.js';

/**
 * DEMO ONLY, opt-in with IAM_DEMO_DATA_SEED=1 (the hosted demo sets it): three triggered workflow
 * definitions so the feature is alive out of the box - a joiner, a mover and a leaver scenario that
 * start from durable application-bus events. Redelivery reuses the same run ID. Idempotent (fixed ids, never overwritten).
 */
const SEEDS: { id: string; name: string; description: string; trigger: WfTrigger; nodes: { id: string; type: string; name: string; config: Record<string, unknown> }[]; edges: { from: string; to: string }[] }[] = [
  {
    id: 'wf-joiner', name: 'Joiner: new hire baseline', description: 'Starts from user.created on the durable bus: grants the employee baseline role (real, on the run branch) and informs the manager (simulated).',
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
  {
    id: 'wf-registration', name: 'Registration: a sign-up request is triaged', description: 'Starts when someone registers on the public sign-up page: HR is told a request waits for e-mail confirmation then approval (simulated).',
    trigger: { event: 'signup.requested' },
    nodes: [
      { id: 'tell', type: 'notify', name: 'Inform HR (simulated)', config: { recipient: 'hr', message: 'sign-up request from {{event.subject}} ({{event.email}}): waiting for confirmation and approval' } },
    ],
    edges: [],
  },
  {
    id: 'wf-onboarding', name: 'Onboarding: a validated registration provisions the account', description: 'Starts when an administrator approves a sign-up: records the entry grade (real) and grants the employee baseline (real) on the run branch, informs the manager (simulated).',
    trigger: { event: 'signup.approved' },
    nodes: [
      { id: 'grade', type: 'set-profile-field', name: 'Record the entry grade', config: { identity: '{{event.subject}}', field: 'hr-attributes.employee_grade', value: 'G1' } },
      { id: 'grant', type: 'assign-role', name: 'Grant the employee baseline', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'manager-of:{{event.subject}}', message: '{{event.subject}} approved and provisioned: grade G1 recorded, employee granted, pending review' } },
    ],
    edges: [{ from: 'grade', to: 'grant' }, { from: 'grant', to: 'tell' }],
  },
  {
    id: 'wf-profile-validation', name: 'Validation: an accepted profile review unlocks baseline', description: 'Starts when a validator accepts someone\'s profile edits: grants the employee baseline (real) and informs HR (simulated). A refused review starts nothing.',
    trigger: { event: 'profile.review-resolved', match: { decision: 'accepted' } },
    nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant the employee baseline', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'tell', type: 'notify', name: 'Inform HR (simulated)', config: { recipient: 'hr', message: 'profile of {{event.subject}} validated by {{event.actor}}: baseline access granted, pending review' } },
    ],
    edges: [{ from: 'grant', to: 'tell' }],
  },
  {
    id: 'wf-finance-member', name: 'Organizations: a finance member becomes payment-creator', description: 'Starts when a user joins the finance organization: grants the payment-creator role (real) and informs the finance manager (simulated).',
    trigger: { event: 'organization.member-added', match: { organization: 'finance' } },
    nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
      { id: 'tell', type: 'notify', name: 'Inform the finance manager (simulated)', config: { recipient: 'finance-manager', message: '{{event.subject}} joined finance: payment-creator granted, pending review' } },
    ],
    edges: [{ from: 'grant', to: 'tell' }],
  },
  {
    id: 'wf-security-member', name: 'Organizations: a security member is only logged', description: 'Starts when a user joins the security office: informs the security office (simulated). The sensitive security-analyst role is never granted by a workflow.',
    trigger: { event: 'organization.member-added', match: { organization: 'security' } },
    nodes: [
      { id: 'tell', type: 'notify', name: 'Inform the security office (simulated)', config: { recipient: 'security', message: '{{event.subject}} joined the security office: review access manually, nothing granted' } },
    ],
    edges: [],
  },
  {
    id: 'wf-hr-onboarding', name: 'HR: a candidate row provisions the account (spike)', description: 'SPIKE workflow-connectors: the watcher polls the SIMULATED candidates sheet (source demo-sheet, no Google credential; switch source to google with a service account in the plugin settings). A row with process=OK builds the prenom.nom@lyam.demo e-mail (Activepieces text-helper + native lower/unaccent), creates the user via the lyam connector (real, on the run branch), grants the role named in the row (real, on the run branch) and marks the row cree=ok. A human still reviews and merges the run branch.',
    trigger: { event: 'google-sheets.row-ready', config: { source: 'demo-sheet', watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' } },
    nodes: [
      { id: 'join', type: 'text-transform', name: 'Join nom.prenom', config: { operation: 'concat', values: '{{event.nom}}\n.\n{{event.prenom}}', separator: '' } },
      { id: 'clean', type: 'text-transform', name: 'Strip accents', config: { operation: 'unaccent', text: '{{steps.join.value}}' } },
      { id: 'lower', type: 'text-transform', name: 'Lowercase the login', config: { operation: 'lower', text: '{{steps.clean.value}}' } },
      { id: 'email', type: 'text-transform', name: 'Build the e-mail', config: { operation: 'concat', values: '{{steps.lower.value}}\n@lyam.demo', separator: '' } },
      { id: 'create', type: 'lyam-create-user', name: 'Create the user (lyam connector)', config: { identity: '{{steps.lower.value}}', displayName: '{{event.prenom}} {{event.nom}}', email: '{{steps.email.value}}', department: '{{event.departement}}' } },
      { id: 'role', type: 'assign-role', name: 'Grant the role named in the row', config: { identity: '{{steps.lower.value}}', role: '{{event.role}}' } },
      { id: 'mark', type: 'google-sheets-update', name: 'Mark the row cree=ok', config: { source: 'demo-sheet', rowNumber: '{{event.rownumber}}', column: 'cree', value: 'ok' } },
      { id: 'tell', type: 'notify', name: 'Inform HR (simulated)', config: { recipient: 'hr', message: '{{event.prenom}} {{event.nom}} onboarded from the candidates sheet: user {{steps.lower.value}} created with role {{event.role}}, pending branch review' } },
    ],
    edges: [{ from: 'join', to: 'clean' }, { from: 'clean', to: 'lower' }, { from: 'lower', to: 'email' }, { from: 'email', to: 'create' }, { from: 'create', to: 'role' }, { from: 'role', to: 'mark' }, { from: 'mark', to: 'tell' }],
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
        if (await this.store.getDefinition(tenant, s.id, this.store.liveRef)) continue;
        const { graph } = validateGraph({ nodes: s.nodes, edges: s.edges });
        const def: DefinitionRow = { id: s.id, tenant, name: s.name, description: s.description, graph, trigger: s.trigger, created_by: 'demo-seed', created_at: now(), updated_at: now() };
        await this.store.putDefinition(def, this.store.liveRef);
        this.log.log(`seeded triggered workflow "${s.name}" (${s.trigger.event})`);
      } catch (e) { this.log.warn(`seed ${s.id} skipped: ${(e as Error).message}`); }
    }
  }
}
