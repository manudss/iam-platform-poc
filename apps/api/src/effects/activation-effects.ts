import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { EffectStore } from './effect-store.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

/**
 * Activation effects: the engine (role diff between two activated data versions -> notification and
 * provisioning fan-out, idempotent per effect key) lives in the base directory plugin
 * (`plugins/directory/effects.mjs`, with the loopback guard in `loopback.mjs`). This core adapter keeps
 * the shared types and the storage (EffectStore) and re-exports the engine.
 */
export interface Snapshot { assignments: { identity_id: string; role_id: string }[] }
export interface ActivationEventIn { tenant: string; seq: number; commit: string }
export interface EffectsDeps {
  store: EffectStore;
  snapshotAt(commit: string): Promise<Snapshot>;
  /** commit of the latest applied activation of the tenant with seq < given seq, if any */
  previousCommit(tenant: string, seq: number): Promise<string | undefined>;
  notifySinkUrl?: string;      // local fictional sink: POST {url}/notify
  provisionTargetUrl?: string; // local demo target: PUT|DELETE {url}/Users/:id/Roles/:role
  timeoutMs?: number;
  /** Optional plugin fan-out of notify.send (best effort: a plugin problem is logged, never an access decision, and never fails the role effects). */
  pluginNotify?(tenant: string, payload: { effectKey: string; to: string; template: string; data: Record<string, unknown> }): Promise<void>;
}
interface Change { subject: string; role: string; change: 'granted' | 'revoked' }

interface DirectoryEffectsModule {
  diff: (prev: Snapshot | undefined, cur: Snapshot) => Change[];
  ActivationEffects: new (d: EffectsDeps) => { handle(e: ActivationEventIn): Promise<{ changes: number; failed: string[] }> };
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'directory', 'effects.mjs')) as DirectoryEffectsModule;

export const diff = plugin.diff;
export const ActivationEffects = plugin.ActivationEffects;
export type ActivationEffects = InstanceType<DirectoryEffectsModule['ActivationEffects']>;
