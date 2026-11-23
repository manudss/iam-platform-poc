import { Injectable } from '@nestjs/common';
import { ActivationService } from './activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';

/** Read-only observation of the permission engine. A journal row is never proof of the current engine state. */
@Injectable()
export class ActivationReadService {
  constructor(private readonly journal: ActivationService, private readonly dolt: DoltService) {}

  async status(tenant: string) {
    const checkedAt = new Date().toISOString();
    let main: string | null = null;
    try { main = await this.dolt.head(); } catch { /* independent reads may still succeed */ }
    if (!this.journal.applyEnabled) return { checkedAt, main, status: 'disabled' as const, core: null };
    try {
      const r = await fetch(`${process.env.IAM_CORE_URL}/v1/version?tenant=${encodeURIComponent(tenant)}`, { signal: AbortSignal.timeout(3000) });
      if (r.status === 404) return { checkedAt, main, status: 'none' as const, core: null };
      if (!r.ok) throw new Error('core read failed');
      const core = await r.json() as { seq?: unknown; commit?: unknown };
      if (!Number.isSafeInteger(core.seq) || Number(core.seq) < 1 || typeof core.commit !== 'string' || !/^[0-9a-v]{8,64}$/.test(core.commit)) throw new Error('invalid core response');
      return { checkedAt, main, status: 'confirmed' as const, core: { seq: Number(core.seq), commit: core.commit }, matchesMain: main ? main === core.commit : null };
    } catch { return { checkedAt, main, status: 'unavailable' as const, core: null }; }
  }
}
