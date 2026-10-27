import { Injectable } from '@nestjs/common';
import { AsyncPlugin, AsyncPluginEvent } from './plugin.contract.js';
import { NotifyManagerPlugin } from './notify-manager.plugin.js';

@Injectable()
export class PluginHost {
  private plugins: AsyncPlugin[] = [new NotifyManagerPlugin()];
  private done = new Set<string>();
  readonly effects: { effectKey: string; detail: string }[] = [];

  /** Idempotent: the same effectKey never runs twice (replayed activation). */
  async dispatch(e: AsyncPluginEvent) {
    for (const p of this.plugins.filter((p) => p.handles(e))) {
      const r = await p.run(e);
      if (this.done.has(r.effectKey)) continue;
      this.done.add(r.effectKey);
      this.effects.push(r);
    }
  }
}
