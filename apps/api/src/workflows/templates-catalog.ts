import { WfNode, WfEdge, WfTrigger } from './model.js';

/**
 * The OFFICIAL workflow template catalog, served by the API (GET /tenants/:t/workflow-templates) so the
 * gallery can merge it with the templates users saved themselves (source 'user') and, later, community
 * picks (source 'community'). A template instantiates into a PAUSED workflow: nothing runs until activated.
 *
 * NOTE: the web editor palette keeps its own copy of these samples (SAMPLE_WORKFLOWS in wf-model.ts) for
 * its "start from a sample" section; the gallery below is the API-driven catalog. The duplication is
 * accepted for the POC: the palette needs the graphs synchronously at module load.
 */
export interface CatalogTemplate { id: string; name: string; description: string; category: string; source: 'official' | 'community'; trigger?: WfTrigger; nodes: WfNode[]; edges: WfEdge[]; /** Community picks carry their author's handle. */ author?: string }

export const OFFICIAL_TEMPLATES: CatalogTemplate[] = [
  { id: 'joiner-on-user-created', name: 'joiner on user.created', category: 'Joiner · Mover · Leaver', source: 'official', trigger: { event: 'user.created' }, description: 'Starts BY ITSELF when a user is created: baseline role for the newcomer, manager informed (simulated)', nodes: [
    { id: 'grant', type: 'assign-role', name: 'Grant employee to the newcomer', config: { identity: '{{event.subject}}', role: 'employee' } },
    { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'hr', message: '{{event.displayName}} joined {{event.department}}' } },
  ], edges: [{ from: 'grant', to: 'tell' }] },
  { id: 'mover-into-finance', name: 'mover into finance', category: 'Joiner · Mover · Leaver', source: 'official', trigger: { event: 'user.department-changed', match: { to: 'finance' } }, description: 'Starts when someone moves INTO finance (match: to = finance): payment access granted, reviewed by a human', nodes: [
    { id: 'grant', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
    { id: 'tell', type: 'notify', name: 'Inform the finance admin (simulated)', config: { recipient: 'finance-admin', message: '{{event.subject}} moved to finance' } },
  ], edges: [{ from: 'grant', to: 'tell' }] },
  { id: 'leaver-on-user-disabled', name: 'leaver on user.disabled', category: 'Joiner · Mover · Leaver', source: 'official', trigger: { event: 'user.disabled' }, description: 'Starts when an account is disabled: access removed for real, on the run branch', nodes: [
    { id: 'revoke', type: 'revoke-role', name: 'Revoke employee', config: { identity: '{{event.subject}}', role: 'employee' } },
    { id: 'move', type: 'set-department', name: 'Move the account to alumni', config: { identity: '{{event.subject}}', department: 'alumni' } },
  ], edges: [{ from: 'revoke', to: 'move' }] },
  { id: 'onboarding', name: 'onboarding', category: 'Joiner · Mover · Leaver', source: 'official', description: 'Joiner: account ready, then access, manager informed (simulated)', nodes: [
    { id: 'prepare', type: 'wait', name: 'Prepare (simulated)', config: { seconds: 2 } },
    { id: 'grant', type: 'assign-role', name: 'Grant accountant to demo-bob', config: { identity: 'demo-bob', role: 'accountant' } },
    { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'manager-of:demo-bob', message: 'Bob is now accountant' } },
  ], edges: [{ from: 'prepare', to: 'grant' }, { from: 'grant', to: 'tell' }] },
  { id: 'offboarding', name: 'offboarding', category: 'Joiner · Mover · Leaver', source: 'official', description: 'Leaver: access removed, then confirmation (simulated)', nodes: [
    { id: 'revoke', type: 'revoke-role', name: 'Revoke payment-creator from demo-bob', config: { identity: 'demo-bob', role: 'payment-creator' } },
    { id: 'move', type: 'set-department', name: 'Move demo-bob to alumni', config: { identity: 'demo-bob', department: 'alumni' } },
    { id: 'tell', type: 'notify', name: 'Confirm to HR (simulated)', config: { recipient: 'hr', message: 'Offboarding done' } },
  ], edges: [{ from: 'revoke', to: 'move' }, { from: 'move', to: 'tell' }] },
  { id: 'hr-onboarding-demo-sheet', name: 'HR onboarding (demo sheet)', category: 'HR & sheets', source: 'official', trigger: { event: 'google-sheets.row-ready', config: { source: 'demo-sheet', watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' } }, description: 'The watcher polls the SIMULATED candidates sheet: a row with process = OK builds nom.prenom@lyam.demo, creates the user (run branch), grants the row role, marks cree=ok', nodes: [
    { id: 'join', type: 'text-transform', name: 'Join nom.prenom', config: { operation: 'concat', values: '{{event.nom}}\n.\n{{event.prenom}}', separator: '' } },
    { id: 'clean', type: 'text-transform', name: 'Strip accents', config: { operation: 'unaccent', text: '{{steps.join.value}}' } },
    { id: 'lower', type: 'text-transform', name: 'Lowercase the login', config: { operation: 'lower', text: '{{steps.clean.value}}' } },
    { id: 'email', type: 'text-transform', name: 'Build the e-mail', config: { operation: 'concat', values: '{{steps.lower.value}}\n@lyam.demo', separator: '' } },
    { id: 'create', type: 'lyam-create-user', name: 'Create the user (lyam connector)', config: { identity: '{{steps.lower.value}}', displayName: '{{event.prenom}} {{event.nom}}', email: '{{steps.email.value}}', department: '{{event.departement}}' } },
    { id: 'role', type: 'assign-role', name: 'Grant the row role', config: { identity: '{{steps.lower.value}}', role: '{{event.role}}' } },
    { id: 'mark', type: 'google-sheets-update', name: 'Mark cree=ok', config: { source: 'demo-sheet', rowNumber: '{{event.rownumber}}', column: 'cree', value: 'ok' } },
    { id: 'tell', type: 'notify', name: 'Inform HR (simulated)', config: { recipient: 'hr', message: '{{event.prenom}} {{event.nom}} onboarded: user {{steps.lower.value}} created with role {{event.role}}, pending branch review' } },
  ], edges: [{ from: 'join', to: 'clean' }, { from: 'clean', to: 'lower' }, { from: 'lower', to: 'email' }, { from: 'email', to: 'create' }, { from: 'create', to: 'role' }, { from: 'role', to: 'mark' }, { from: 'mark', to: 'tell' }] },
  { id: 'sod-blocked', name: 'SoD blocked', category: 'Governance', source: 'official', description: 'A grant that breaks segregation of duties: run completes, merge is refused at review', nodes: [
    { id: 'grant', type: 'assign-role', name: 'Give payment-approver to demo-bob', config: { identity: 'demo-bob', role: 'payment-approver' } },
    { id: 'oops', type: 'fail', name: 'External ticket fails (simulated)', config: { message: 'ticket system unreachable (demo)' } },
  ], edges: [{ from: 'grant', to: 'oops' }] },
  { id: 'branch-by-department', name: 'branch by department', category: 'Logic patterns', source: 'official', trigger: { event: 'user.department-changed' }, description: 'If/Switch branching: finance movers take the payment path, others the standard one; both merge before the notification', nodes: [
    { id: 'cond', type: 'if', name: 'Moving to finance?', config: { left: '{{event.to}}', op: 'equals', right: 'finance' } },
    { id: 'fin', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
    { id: 'std', type: 'notify', name: 'Standard move (simulated)', config: { recipient: 'hr', message: '{{event.subject}} moved to {{event.to}}' } },
    { id: 'join', type: 'merge', name: 'Continue in all cases', config: {} },
    { id: 'tell', type: 'notify', name: 'Confirm to HR (simulated)', config: { recipient: 'hr', message: 'Department change handled' } },
  ], edges: [{ from: 'cond', to: 'fin', label: 'true' }, { from: 'cond', to: 'std', label: 'false' }, { from: 'fin', to: 'join' }, { from: 'std', to: 'join' }, { from: 'join', to: 'tell' }] },
  { id: 'loop-over-rows', name: 'loop over rows', category: 'HR & sheets', source: 'official', trigger: { event: 'google-sheets.row-ready' }, description: 'Loop: for each role of the row, grant it on the run branch; the loop output carries item/index/count', nodes: [
    { id: 'each', type: 'loop', name: 'For each requested role', config: { items: '{{event.roles}}', maxItems: 10 } },
    { id: 'grant', type: 'assign-role', name: 'Grant the role', config: { identity: '{{event.subject}}', role: '{{steps.each.item}}' } },
    { id: 'tell', type: 'notify', name: 'Summary to HR (simulated)', config: { recipient: 'hr', message: '{{steps.each.count}} role(s) processed' } },
  ], edges: [{ from: 'each', to: 'grant', label: 'each' }, { from: 'each', to: 'tell', label: 'done' }] },
];

/**
 * COMMUNITY picks (phase 3): a static, curated list of templates attributed to their authors, served next
 * to the official catalog. Static on purpose for the POC - there is no submission/moderation flow yet.
 */
export const COMMUNITY_TEMPLATES: CatalogTemplate[] = [
  { id: 'community-weekly-access-review', name: 'Weekly access review reminder', category: 'Governance', source: 'community', author: '@claire-iam', trigger: { cron: '0 9 * * 1' }, description: 'Every Monday at 09:00 (Europe/Paris): remind HR to review the access changes of the week (simulated notification)', nodes: [
    { id: 'tell', type: 'notify', name: 'Remind HR (simulated)', config: { recipient: 'hr', message: 'Weekly access review: check the pull requests opened by workflows' } },
  ], edges: [] },
  { id: 'community-newcomer-welcome', name: 'Newcomer welcome notes', category: 'Joiner · Mover · Leaver', source: 'community', author: '@hr-ops', trigger: { event: 'user.created' }, description: 'When a user is created: two simulated notes, one to the manager, one to the welcome channel', nodes: [
    { id: 'mgr', type: 'notify', name: 'Note to the manager (simulated)', config: { recipient: 'manager-of:{{event.subject}}', message: '{{event.displayName}} starts in {{event.department}}' } },
    { id: 'all', type: 'notify', name: 'Note to the welcome channel (simulated)', config: { recipient: 'welcome', message: 'Say hi to {{event.displayName}} ({{event.department}})' } },
  ], edges: [{ from: 'mgr', to: 'all' }] },
  { id: 'community-leaver-access-audit', name: 'Leaver access audit', category: 'Governance', source: 'community', author: '@sec-anna', trigger: { event: 'user.disabled' }, description: 'When an account is disabled: the baseline role is revoked (real, run branch) and the audit team gets a simulated summary', nodes: [
    { id: 'revoke', type: 'revoke-role', name: 'Revoke employee', config: { identity: '{{event.subject}}', role: 'employee' } },
    { id: 'audit', type: 'notify', name: 'Audit summary (simulated)', config: { recipient: 'audit', message: 'Leaver {{event.subject}}: baseline access revoked, pending branch review' } },
  ], edges: [{ from: 'revoke', to: 'audit' }] },
  { id: 'community-nightly-orphan-check', name: 'Nightly orphan-account check', category: 'Governance', source: 'community', author: '@claire-iam', trigger: { cron: '0 2 * * *' }, description: 'Every night at 02:00 (Europe/Paris): a simulated nudge to look at accounts without a manager', nodes: [
    { id: 'tell', type: 'notify', name: 'Nudge the ops channel (simulated)', config: { recipient: 'ops', message: 'Nightly check: review orphan accounts (no manager) before the morning' } },
  ], edges: [] },
];
