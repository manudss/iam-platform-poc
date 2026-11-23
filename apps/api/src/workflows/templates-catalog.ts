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
  { id: 'badge-request-from-sheet', name: 'Badge request (sheet OK > account > Jira ticket)', category: 'HR & sheets', source: 'official', trigger: { event: 'google-sheets.row-ready', config: { source: 'google', connectionId: '', spreadsheetId: 'REPLACE-WITH-SPREADSHEET-ID', sheetId: 0, watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' } }, description: 'Phase 1. A row with process = OK builds the login, creates the account (login disabled), publishes it to main, blocks it, opens a Jira ticket asking for the badge and RECORDS the ticket > account > row correlation the phase 2 workflow relies on. The sheet needs a column "email" that is unique per person: the row is found again by it, never by its number. Instantiates paused and simulated: real Sheets and Jira need a confirmed managed connection on each block, and the workflow must be listed in publishAllowedWorkflows.', nodes: [
    { id: 'preflight', type: 'google-sheets-read', name: 'Check the unique row and required sheet headers before effects', config: { source: 'google', spreadsheetId: 'REPLACE-WITH-SPREADSHEET-ID', sheetId: 0, mode: 'find-row', columnName: 'email', searchValue: '{{event.email}}', requiredColumns: 'email,ticket,badge,cree' } },
    { id: 'join', type: 'text-transform', name: 'Join nom.prenom', config: { operation: 'concat', values: '{{event.nom}}\n.\n{{event.prenom}}', separator: '' } },
    { id: 'clean', type: 'text-transform', name: 'Strip accents', config: { operation: 'unaccent', text: '{{steps.join.value}}' } },
    { id: 'lower', type: 'text-transform', name: 'Lowercase the login', config: { operation: 'lower', text: '{{steps.clean.value}}' } },
    { id: 'create', type: 'lyam-create-user', name: 'Create the account (login disabled)', config: { identity: '{{steps.lower.value}}', displayName: '{{event.prenom}} {{event.nom}}', email: '{{event.email}}', department: '{{event.departement}}' } },
    { id: 'publish', type: 'lyam-publish-workspace', name: 'Publish the account to main', config: {} },
    { id: 'block', type: 'lyam-block-account', name: 'Block the account until the badge is ready', config: { subject: '{{steps.lower.value}}', kind: 'suspended', exclusive: 'yes', message: 'Your badge is being prepared. You will receive an e-mail when your account is ready.' } },
    { id: 'ticket', type: 'jira-create-issue', name: 'Ask for the badge (Jira)', config: { project: 'KAN', issueTypeId: '10003', labels: 'badge-demo', summary: '[Badge] Préparer le badge de {{event.prenom}} {{event.nom}}', description: 'Demande automatique de la démo Lyam. Personne : {{event.prenom}} {{event.nom}}, département {{event.departement}}, rôle {{event.role}}. Merci de préparer le badge puis de passer ce ticket en Done. Le compte sera activé et le mail envoyé automatiquement. Aucun mot de passe dans ce ticket.' } },
    { id: 'link', type: 'lyam-link-ticket', name: 'Record the ticket > account > row link', config: { connectionId: 'jira-demo', project: 'KAN', issueKey: '{{steps.ticket.key}}', account: '{{steps.lower.value}}', source: 'google', spreadsheetId: 'REPLACE-WITH-SPREADSHEET-ID', sheetId: 0, keyColumn: 'email', keyValue: '{{event.email}}' } },
    { id: 'trace', type: 'google-sheets-update', name: 'Write the ticket key in the sheet', config: { source: 'google', spreadsheetId: 'REPLACE-WITH-SPREADSHEET-ID', sheetId: 0, keyColumn: 'email', keyValue: '{{event.email}}', column: 'ticket', value: '{{steps.ticket.key}}' } },
    { id: 'mark', type: 'google-sheets-update', name: 'Mark cree=ok', config: { source: 'google', spreadsheetId: 'REPLACE-WITH-SPREADSHEET-ID', sheetId: 0, keyColumn: 'email', keyValue: '{{event.email}}', column: 'cree', value: 'ok' } },
  ], edges: [{ from: 'preflight', to: 'join' }, { from: 'join', to: 'clean' }, { from: 'clean', to: 'lower' }, { from: 'lower', to: 'create' }, { from: 'create', to: 'publish' }, { from: 'publish', to: 'block' }, { from: 'block', to: 'ticket' }, { from: 'ticket', to: 'link' }, { from: 'link', to: 'trace' }, { from: 'trace', to: 'mark' }] },
  { id: 'badge-done-temporary-password', name: 'Badge done (Jira Done > temporary password > mail > unblock)', category: 'HR & sheets', source: 'official', trigger: { event: 'jira.issue-done', config: { connectionId: 'jira-demo', project: 'KAN', label: 'badge-demo', doneStatus: 'Done', lookbackDays: 7 } }, description: 'Phase 2. For a Done ticket: resolves the account and the sheet row from the server correlation (the Jira text is never used), finds the row again by its key column (exactly one row or stop), generates a temporary password (never shown), records it as temporary with a forced change at first sign-in, explicitly enables directory login on the run branch while the owned suspension remains in force, publishes to main, sends the mail only after the real state is re-read, lifts the block last, writes "badge fait / mail envoyé" in the sheet and marks the ticket handled. Instantiates paused and simulated for Sheets; the lyam blocks act for real once a run is not a test, so activate only after the path is qualified.', nodes: [
    { id: 'resolve', type: 'lyam-resolve-ticket', name: 'Resolve account and row from the server record', config: { connectionId: 'jira-demo', project: 'KAN', issueKey: '{{event.key}}' } },
    { id: 'find', type: 'google-sheets-read', name: 'Find the row by its key', config: { source: 'google', spreadsheetId: '{{steps.resolve.spreadsheetId}}', sheetId: 0, mode: 'find-row', columnName: '{{steps.resolve.keyColumn}}', searchValue: '{{steps.resolve.keyValue}}', requiredColumns: 'badge' } },
    { id: 'one', type: 'if', name: 'Exactly one row?', config: { left: '{{steps.find.count}}', op: 'equals', right: '1' } },
    { id: 'stop', type: 'fail', name: 'Row absent or ambiguous: stop', config: { mode: 'always', message: 'The sheet row of this ticket is absent or not unique. Nothing was changed.' } },
    { id: 'gen', type: 'lyam-generate-password', name: 'Generate the temporary password', config: {} },
    { id: 'set', type: 'lyam-set-temporary-password', name: 'Set it as temporary (change forced)', config: { subject: '{{steps.resolve.account}}', passwordRef: '{{steps.gen.passwordRef}}', hours: '24' } },
    { id: 'enable', type: 'lyam-set-login-enabled', name: 'Enable directory login on the run branch (still suspended)', config: { id: '{{steps.resolve.account}}', enabled: 'yes' } },
    { id: 'publish', type: 'lyam-publish-workspace', name: 'Publish to main', config: {} },
    { id: 'mail', type: 'lyam-send-secret-mail', name: 'Send the temporary password mail', config: { account: '{{steps.resolve.account}}', to: '{{steps.resolve.email}}', subject: 'Votre accès Lyam est prêt', text: 'Bonjour, votre badge est prêt et votre compte Lyam est activé. Identifiant : {{steps.resolve.account}}. Mot de passe temporaire : [[password]]. Il expire dans [[hours]] heures (échéance : [[expiry]]) et vous devrez en choisir un nouveau à la première connexion. Adresse : https://lyam.dss.name. Message de démonstration, compte fictif.', passwordRef: '{{steps.gen.passwordRef}}', hours: '24', revision: '{{steps.set.revision}}', sourceHead: '{{steps.publish.sourceHead}}', ownerRun: '{{steps.resolve.phase1Run}}' } },
    { id: 'unblock', type: 'lyam-unblock-account', name: 'Lift the block (last)', config: { subject: '{{steps.resolve.account}}', kind: 'suspended', ownerRun: '{{steps.resolve.phase1Run}}' } },
    { id: 'mark', type: 'google-sheets-update', name: 'Write "badge fait / mail envoyé"', config: { source: 'google', spreadsheetId: '{{steps.resolve.spreadsheetId}}', sheetId: 0, keyColumn: '{{steps.resolve.keyColumn}}', keyValue: '{{steps.resolve.keyValue}}', column: 'badge', value: 'badge fait / mail envoyé' } },
    { id: 'done', type: 'lyam-complete-ticket', name: 'Mark the ticket handled', config: { connectionId: 'jira-demo', project: 'KAN', issueKey: '{{event.key}}' } },
  ], edges: [{ from: 'resolve', to: 'find' }, { from: 'find', to: 'one' }, { from: 'one', to: 'gen', label: 'true' }, { from: 'one', to: 'stop', label: 'false' }, { from: 'gen', to: 'set' }, { from: 'set', to: 'enable' }, { from: 'enable', to: 'publish' }, { from: 'publish', to: 'mail' }, { from: 'mail', to: 'unblock' }, { from: 'unblock', to: 'mark' }, { from: 'mark', to: 'done' }] },
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
  { id: 'recertification-denial-remediation', name: 'recertification: review > conditional remediation loop > publish > close', category: 'Governance', source: 'official', description: 'MANUAL start (no schedule: activate and configure deliberately). The full IGA loop, proven end to end on a real Dolt base: a campaign snapshots the users in scope, the IGA pool reviews each item (anti-self-approval enforced), then a CONDITION keeps the two paths apart: nothing denied = straight to the strict close, no branch, no pull request, every right preserved. A denial prepares the remediation and a LOOP revokes each denied role of each denied identity on the run branch (the actions come from the prepare step, never a fixed id); the publication is requested and APPROVED by an administrator but only lands when the pull request is really MERGED (the run watches the real PR state); a second loop marks each denied item remediated only after the revocation is verified effective on the campaign ref; the campaign closes with its complete evidence file (an unresolved item blocks the closure unless a human exception is justified). Before activating, replace the campaign scope (replace-with-user-id) with the users to recertify.', nodes: [
    { id: 'campaign', type: 'iga-create-campaign', name: 'Create the campaign', config: { name: 'Access recertification', granularity: 'access', users: 'replace-with-user-id', ref: 'main' } },
    { id: 'open', type: 'iga-open-review-tasks', name: 'Open the review tasks (IGA pool)', config: { campaignId: '{{steps.campaign.id}}', assignTo: 'iga' } },
    { id: 'await', type: 'iga-await-decisions', name: 'Await the review decisions', config: { campaignId: '{{steps.campaign.id}}' } },
    { id: 'any', type: 'if', name: 'Any denial?', config: { left: '{{steps.await.denied}}', op: 'gt', right: '0' } },
    { id: 'prepare', type: 'iga-prepare-remediation', name: 'Prepare the remediation of denied items', config: { campaignId: '{{steps.campaign.id}}' } },
    { id: 'revloop', type: 'loop', name: 'For each denied role', config: { items: '{{steps.prepare.actions}}', maxItems: 50 } },
    { id: 'revoke', type: 'lyam-revoke-assignment', name: 'Revoke the denied role', config: { action: '{{steps.revloop.item}}' } },
    { id: 'publish', type: 'lyam-request-publish', name: 'Request the publication (approval, then real merge)', config: { title: 'Recertification remediation' } },
    { id: 'fixloop', type: 'loop', name: 'For each denied identity', config: { items: '{{steps.prepare.deniedItems}}', maxItems: 50 } },
    { id: 'mark', type: 'iga-mark-remediated', name: 'Mark remediated (verified effective)', config: { campaignId: '{{steps.campaign.id}}', item: '{{steps.fixloop.item}}', note: 'revoked and published' } },
    { id: 'join', type: 'merge', name: 'Join the two paths', config: {} },
    { id: 'close', type: 'iga-close-campaign', name: 'Close the campaign (strict, evidence file)', config: { campaignId: '{{steps.campaign.id}}' } },
  ], edges: [{ from: 'campaign', to: 'open' }, { from: 'open', to: 'await' }, { from: 'await', to: 'any' }, { from: 'any', to: 'prepare', label: 'true' }, { from: 'any', to: 'join', label: 'false' }, { from: 'prepare', to: 'revloop' }, { from: 'revloop', to: 'revoke', label: 'each' }, { from: 'revloop', to: 'publish', label: 'done' }, { from: 'publish', to: 'fixloop' }, { from: 'fixloop', to: 'mark', label: 'each' }, { from: 'fixloop', to: 'join', label: 'done' }, { from: 'join', to: 'close' }] },
  { id: 'password-reset-approved', name: 'Password reset (approval > temporary password > mail > unblock)', category: 'Access', source: 'official', description: 'FROZEN, NOT READY: the server refuses activation and real execution of this path before the first step. Editor simulation remains available. Reset path with an approval bound to its effect. An admin-pool approval task (anti-self) for ONE account and ONE validity; on approval: blocks the account, generates a temporary password (never shown), applies it ONLY through the approval-bound step (same run, same account, same validity, target not an administrator at that moment), publishes, sends the mail (approval and non-admin status re-checked right before it leaves, then the real state), lifts the block last. Replace the account id before activating. The temporary credential is versioned on the run branch until published; the forced first-access change and the block are immediate. The mail goes only to the allowed recipients and carries the temporary secret; the recipient e-mail is read once and persisted in the run history. Instantiate paused: qualify the path before activating.', nodes: [
    { id: 'propose', type: 'lyam-propose-password-reset', name: 'Approval of the reset (admin pool)', config: { subject: 'replace-with-user-id', hours: '24', reason: 'Describe why the reset is needed' } },
    { id: 'ok', type: 'if', name: 'Approved?', config: { left: '{{steps.propose.decision}}', op: 'equals', right: 'approved' } },
    { id: 'stop', type: 'fail', name: 'Refused: nothing was changed', config: { mode: 'always', message: 'The reset was not approved. Nothing was changed.' } },
    { id: 'user', type: 'lyam-read-user', name: 'Read the account e-mail (PII, persisted)', config: { id: '{{steps.propose.subject}}', ref: 'base', includeEmail: 'yes' } },
    { id: 'block', type: 'lyam-block-account', name: 'Block the account during the reset', config: { subject: '{{steps.propose.subject}}', kind: 'suspended', exclusive: 'yes', message: 'Your password is being reset. You will receive an e-mail when it is ready.' } },
    { id: 'gen', type: 'lyam-generate-password', name: 'Generate the temporary password', config: {} },
    { id: 'apply', type: 'lyam-apply-password-reset', name: 'Apply the approved reset (bound to the approval)', config: { approvalTaskId: '{{steps.propose.taskId}}', subject: '{{steps.propose.subject}}', passwordRef: '{{steps.gen.passwordRef}}', hours: '24' } },
    { id: 'publish', type: 'lyam-publish-workspace', name: 'Publish to main', config: { resetApprovalTaskId: '{{steps.propose.taskId}}', resetSubject: '{{steps.propose.subject}}', resetHours: '24', resetRevision: '{{steps.apply.revision}}' } },
    { id: 'mail', type: 'lyam-send-secret-mail', name: 'Send the temporary password mail', config: { account: '{{steps.propose.subject}}', to: '{{steps.user.email}}', subject: 'Your password was reset', text: 'Your password was reset. Temporary password: [[password]]\nIt expires on [[expiry]] ([[hours]] hours). You must choose a new password at your first sign-in.', passwordRef: '{{steps.gen.passwordRef}}', hours: '24', revision: '{{steps.apply.revision}}', sourceHead: '{{steps.publish.sourceHead}}', ownerRun: '{{steps.block.ownerRun}}', resetApprovalTaskId: '{{steps.propose.taskId}}' } },
    { id: 'unblock', type: 'lyam-unblock-account', name: 'Lift the block (last)', config: { subject: '{{steps.propose.subject}}', kind: 'suspended', ownerRun: '{{steps.block.ownerRun}}' } },
  ], edges: [{ from: 'propose', to: 'ok' }, { from: 'ok', to: 'user', label: 'true' }, { from: 'ok', to: 'stop', label: 'false' }, { from: 'user', to: 'block' }, { from: 'block', to: 'gen' }, { from: 'gen', to: 'apply' }, { from: 'apply', to: 'publish' }, { from: 'publish', to: 'mail' }, { from: 'mail', to: 'unblock' }] },
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
