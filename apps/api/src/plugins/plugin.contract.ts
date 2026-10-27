/**
 * Plugin contract v0 (see docs/plugin-contract-v0.md).
 * - Blocking hooks run in the Rust core (WASM, fuel-limited, no imports).
 * - Async plugins run here (NestJS) and must be idempotent per (tenant, activation, effect, target).
 */
export interface AsyncPluginEvent {
  tenant: string;
  activation: number;
  commit: string;
  type: 'role.changed';
  subject: string;
  newRole: string;
}

export interface AsyncPlugin {
  name: string;
  handles(e: AsyncPluginEvent): boolean;
  run(e: AsyncPluginEvent): Promise<{ effectKey: string; detail: string }>;
}
