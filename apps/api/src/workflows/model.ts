import { loadPluginModule, pluginCatalogue } from '../plugins/v1/loader.js';

/**
 * Workflow model: the graph/step types below are shared with the core, but every rule (step catalogue,
 * trigger events, validation, placeholder substitution) lives in the `workflows-iga` plugin folder
 * (`plugins/workflows-iga/model.mjs`). This file is the core adapter: types here, rules re-exported.
 *
 * Workflow definitions are DIRECTED ACYCLIC GRAPHS of typed steps, authored in the visual editor.
 * Two families of steps, never mixed up in the API or the UI:
 *  - SIMULATED steps (wait, notify, fail): they demonstrate the flow but have no external effect
 *    (a "notify" step only writes a log line; nothing is ever sent to anyone).
 *  - REAL data steps (assign-role, revoke-role, set-department): they write business data, always on
 *    the run's own Dolt branch (wf-<run id>), never on main. Publishing stays the existing explicit
 *    review/merge path (pull request / Apply), done by a human, not by the workflow.
 */
export type StepType = string;
export type BuiltinStepType = 'wait' | 'notify' | 'fail' | 'assign-role' | 'revoke-role' | 'set-department' | 'set-profile-field';

/** Start trigger of a definition: run automatically when `event` fires and every `match` key equals the payload value,
 * or on a schedule (`cron`, five fields, Europe/Paris, no catch-up). External events may carry a validated
 * `config` (e.g. webhook token, watched sheet). event and cron are exclusive. */
export interface WfTrigger { event?: string; match?: Record<string, string>; config?: Record<string, unknown>; cron?: string }
export interface WfNode { id: string; type: StepType; name: string; config: Record<string, unknown> }
export interface WfEdge { from: string; to: string; /** Branching links carry the case they follow: true/false, a switch case, each/done. */ label?: string }
export interface WfGraph { nodes: WfNode[]; edges: WfEdge[] }

export type StepCategory = 'simulated' | 'computed' | 'real';
/** A workflow block contributed by a plugin on the `workflows.blocks` surface (its manifest entrypoints.blocks). */
export interface WfBlockField { key: string; label: string; type: 'string' | 'text' | 'number' | 'boolean' | 'select'; required?: boolean; default?: unknown; options?: string[]; help?: string }
export interface WfBlockCtx {
  tenant: string; config: Record<string, unknown>; settings: Record<string, unknown>; dryRun: boolean;
  log: (line: string) => void; outputs: Record<string, Record<string, unknown>>;
  /** Test run: blocks with an immediate effect only log what they would do. */
  test?: boolean; runId?: string; nodeId?: string; accounts?: import('./engine.js').AccountEffects;
  /** Server-derived badge context; never configurable by the graph. Generic temporary workflows do not use it. */
  badgeMode?: 'request' | 'done';
  preflightBadgeDelivery?: (candidate: Record<string, unknown>) => Promise<Record<string, unknown>>;
  badgeCandidate?: () => Promise<Record<string, unknown>>;
  /** Current main policy for real mail, read again immediately before the final state guards/send. */
  liveMailSettings?: () => Promise<Record<string, unknown>>;
  /** Authentication effects (immediate, unversioned for unenroll/notify; versioned for the policy save). */
  authn?: import('./engine.js').AuthnEffects;
  /** Records the durable intent of an immediate external effect right before it fires (a crash leaves the step in review, never a blind retry). */
  markEffectPending?: (intent: Record<string, unknown>) => Promise<unknown>;
  /** Durable-wait context (the recorded task id), the run starter (anti-self-approval) and the run's base branch. */
  resumeWait?: { taskId?: string; kind?: string; campaignId?: string } | null;
  startedBy?: string; baseBranch?: string; runBranch?: string | null;
  /** Shared business services (durable tasks, typed reads, IGA campaigns, child runs, policy validation). Absent in minimal servers: the block refuses honestly. */
  tasks?: import('./tasks.js').WorkflowTasksService;
  reads?: import('./reads.js').WorkflowReads;
  iga?: import('./iga.service.js').WorkflowsIgaService;
  runs?: { get: (tenant: string, runId: string) => Promise<Record<string, unknown>>; start: (tenant: string, workflowId: string, input: Record<string, unknown>, startedBy: string) => Promise<Record<string, unknown>> };
  publish?: { diff: (from: string, to: string) => Promise<unknown>; status: (tenant: string, id: number) => Promise<{ pullRequest: unknown }>; request: (tenant: string, runId: string, title: string) => Promise<{ pullRequest: Record<string, unknown>; reused: boolean }> };
  intake?: { finalize?: (subject: string) => Promise<unknown>; read: (kind: string, subject: string) => Promise<Record<string, unknown>>; resolve: (kind: string, subject: string, snapshot: string, decision: string) => Promise<Record<string, unknown>> };
  connectionTests?: { test: (tenant: string, ref: string, ids: string[], startedBy: string) => Promise<Record<string, unknown>> };
  policies?: { validate: (tenant: string, candidate: unknown) => Promise<Record<string, unknown>> };
  branchWrite: (fn: (db: { query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]> }) => Promise<void>, message?: string) => Promise<void>;
}
export interface WfBlock {
  type: string; family: string; label: string; simulated: boolean; category?: StepCategory; description: string;
  fields: WfBlockField[]; outputs: { key: string; description: string }[];
  validate: (cfg: Record<string, unknown>) => Record<string, unknown>;
  run: (ctx: WfBlockCtx) => Promise<Record<string, unknown> | undefined>;
  pluginId?: string;
}
export interface WfTriggerEvent {
  label: string; payload: string[]; configFields?: WfBlockField[];
  poll?: (config: Record<string, unknown>, deps: { settings: Record<string, unknown>; log?: (m: string) => void }) => Promise<{ rowNumber: number; values: Record<string, unknown> }[]>;
}

interface WfModelModule {
  STEP_TYPES: Record<StepType, { simulated: boolean; label: string; category?: StepCategory }>;
  WF_EVENTS: Record<string, { label: string; payload: string[]; configFields?: WfBlockField[] }>;
  LOGIC_FIELDS: Record<string, WfBlockField[]>;
  placeholderKeys: (value: unknown) => string[];
  stepPlaceholderRefs: (value: unknown) => { node: string; key: string }[];
  substituteStepOutputs: (node: WfNode, outputs: Record<string, Record<string, unknown>>) => WfNode;
  validateStepPlaceholders: (graph: WfGraph, order: string[]) => void;
  validateTrigger: (input: unknown) => WfTrigger | null;
  validateCronExpression: (expr: unknown) => string;
  nextCronFire: (expr: string, fromMs?: number) => number;
  substituteEventPayload: (graph: WfGraph, payload: Record<string, string>) => WfGraph;
  validateGraph: (input: unknown) => { graph: WfGraph; order: string[] };
  hasDataSteps: (g: WfGraph) => boolean;
  registerExternalBlocks: (blocks: WfBlock[]) => void;
  registerExternalEvents: (events: Record<string, WfTriggerEvent>) => void;
  externalBlock: (type: string) => WfBlock | undefined;
  externalBlockProvider: (type: string) => string | undefined;
  externalEvent: (event: string) => WfTriggerEvent | undefined;
  isWildcardEvent: (event: string) => boolean;
}
const plugin = loadPluginModule('workflows-iga', 'model.mjs') as WfModelModule;

// ---- Block catalogue merge: every shipped plugin declaring a `blocks` entrypoint contributes its step
// types and trigger events to the workflow model (the `workflows.blocks` surface). The catalogue is
// process-wide (like the plugin code itself); whether a provider plugin is ENABLED is checked per tenant
// and branch at save/start/run time through the registry.
for (const impl of pluginCatalogue().impls()) {
  const ep = impl.manifest.entrypoints?.['blocks'];
  if (!ep) continue;
  const mod = loadPluginModule(impl.manifest.id, ep) as { BLOCKS?: WfBlock[]; TRIGGER_EVENTS?: Record<string, WfTriggerEvent> };
  plugin.registerExternalBlocks((mod.BLOCKS ?? []).map((b) => ({ ...b, pluginId: impl.manifest.id })));
  plugin.registerExternalEvents(mod.TRIGGER_EVENTS ?? {});
}

export const STEP_TYPES = plugin.STEP_TYPES;
export const WF_EVENTS = plugin.WF_EVENTS;
export const placeholderKeys = plugin.placeholderKeys;
export const stepPlaceholderRefs = plugin.stepPlaceholderRefs;
export const substituteStepOutputs = plugin.substituteStepOutputs;
export const validateStepPlaceholders = plugin.validateStepPlaceholders;
export const validateTrigger = plugin.validateTrigger;
export const validateCronExpression = plugin.validateCronExpression;
export const nextCronFire = plugin.nextCronFire;
export const substituteEventPayload = plugin.substituteEventPayload;
export const validateGraph = plugin.validateGraph;
export const hasDataSteps = plugin.hasDataSteps;
export const externalBlock = plugin.externalBlock;
export const externalBlockProvider = plugin.externalBlockProvider;
export const externalEvent = plugin.externalEvent;
export const isWildcardEvent = plugin.isWildcardEvent;

/** Badge category of a step type: simulated (nothing really happens) | computed (really runs, no external effect) | real. */
export const stepCategoryOf = (type: StepType): StepCategory => STEP_TYPES[type]?.category ?? (STEP_TYPES[type]?.simulated ? 'simulated' : 'real');

/** The merged block catalogue for the editor palette: built-in step types first, then contributed blocks. */
export function blockCatalogue(): { type: string; family: string; label: string; simulated: boolean; category: StepCategory; description: string; fields: WfBlockField[]; outputs: { key: string; description: string }[]; provider: string | null }[] {
  const builtins: Record<string, { hint: string }> = {
    wait: { hint: 'Simulated delay (seconds)' },
    notify: { hint: 'Simulated: logged, never sent' },
    fail: { hint: 'Simulated error: fails once, recovers on retry' },
    'assign-role': { hint: 'Real, on the run branch' },
    'revoke-role': { hint: 'Real, on the run branch' },
    'set-department': { hint: 'Real, on the run branch' },
    'set-profile-field': { hint: 'Real, on the run branch' },
  };
  const out = Object.entries(builtins).map(([type, b]) => ({ type, family: 'Core', label: STEP_TYPES[type].label, simulated: STEP_TYPES[type].simulated, category: stepCategoryOf(type), description: b.hint, fields: [] as WfBlockField[], outputs: [] as { key: string; description: string }[], provider: null as string | null }));
  // Flow-control blocks (Logic family): they really evaluate at run time, have no external effect, and
  // branch the run through labeled links (true/false, case/default, each/done) or catch failures (error).
  const logic: { type: string; hint: string; outputs: { key: string; description: string }[] }[] = [
    { type: 'if', hint: 'Branches on a condition: outgoing links labeled true / false', outputs: [{ key: 'branch', description: '"true" or "false"' }, { key: 'result', description: 'the condition result (boolean)' }] },
    { type: 'switch', hint: 'Branches on a value: outgoing links labeled with a case, or default', outputs: [{ key: 'branch', description: 'the matched case, or "default"' }] },
    { type: 'loop', hint: 'Runs its body (links labeled each) once per item, then the done links', outputs: [{ key: 'item', description: 'the current item (per iteration)' }, { key: 'index', description: 'the current iteration, 0-based' }, { key: 'count', description: 'the number of items' }] },
    { type: 'merge', hint: 'Joins paths: runs as soon as one incoming link arrives', outputs: [{ key: 'arrived', description: 'the incoming steps that arrived' }] },
  ];
  for (const b of logic) out.push({ type: b.type, family: 'Logic', label: STEP_TYPES[b.type].label, simulated: true, category: stepCategoryOf(b.type), description: b.hint, fields: plugin.LOGIC_FIELDS?.[b.type] ?? [], outputs: b.outputs, provider: null });
  const seen = new Set(out.map((b) => b.type));
  for (const impl of pluginCatalogue().impls()) {
    if (!impl.manifest.entrypoints?.['blocks']) continue;
    for (const b of impl.manifest ? (loadPluginModule(impl.manifest.id, impl.manifest.entrypoints['blocks']) as { BLOCKS?: WfBlock[] }).BLOCKS ?? [] : []) {
      if (seen.has(b.type)) continue;
      seen.add(b.type);
      out.push({ type: b.type, family: b.family, label: b.label, simulated: b.simulated, category: b.category ?? (b.simulated ? 'simulated' : 'real'), description: b.description, fields: b.fields ?? [], outputs: b.outputs ?? [], provider: impl.manifest.id });
    }
  }
  return out;
}

/** Execution badge, not the block catalogue's capability. Never label a dry-run external effect Real. */
export function runStepCategory(node: WfNode, test = false, output?: Record<string, unknown> | null): StepCategory {
  const category = stepCategoryOf(node.type);
  const managed = /^(google-sheets-|jira-)/.test(node.type) || node.type === 'http-request';
  return managed && (test || node.config.executionMode !== 'real' || node.config.dryRun === true || output?.['dryRun'] === true) ? 'simulated' : category;
}
