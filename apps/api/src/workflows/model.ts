import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

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
export type StepType = 'wait' | 'notify' | 'fail' | 'assign-role' | 'revoke-role' | 'set-department' | 'set-profile-field';

/** Start trigger of a definition: run automatically when `event` fires and every `match` key equals the payload value. */
export interface WfTrigger { event: string; match?: Record<string, string> }
export interface WfNode { id: string; type: StepType; name: string; config: Record<string, unknown> }
export interface WfEdge { from: string; to: string }
export interface WfGraph { nodes: WfNode[]; edges: WfEdge[] }

interface WfModelModule {
  STEP_TYPES: Record<StepType, { simulated: boolean; label: string }>;
  WF_EVENTS: Record<string, { label: string; payload: string[] }>;
  placeholderKeys: (value: unknown) => string[];
  validateTrigger: (input: unknown) => WfTrigger | null;
  substituteEventPayload: (graph: WfGraph, payload: Record<string, string>) => WfGraph;
  validateGraph: (input: unknown) => { graph: WfGraph; order: string[] };
  hasDataSteps: (g: WfGraph) => boolean;
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'workflows-iga', 'model.mjs')) as WfModelModule;

export const STEP_TYPES = plugin.STEP_TYPES;
export const WF_EVENTS = plugin.WF_EVENTS;
export const placeholderKeys = plugin.placeholderKeys;
export const validateTrigger = plugin.validateTrigger;
export const substituteEventPayload = plugin.substituteEventPayload;
export const validateGraph = plugin.validateGraph;
export const hasDataSteps = plugin.hasDataSteps;
