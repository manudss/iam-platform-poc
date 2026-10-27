import { Injectable } from '@nestjs/common';

export interface Activation {
  tenant: string;
  seq: number; // increasing per tenant
  commit: string; // Dolt commit hash = data version
  state: 'activated';
}

/**
 * v0 in-memory stand-in for the runtime activation journal (target: dedicated PostgreSQL).
 * A merge changes nothing; only an explicit activation makes a Dolt commit live.
 * Re-activating an older commit (A -> B -> A) is a NEW activation with a new seq.
 * TODO(POC): durable journal, Dolt tag as reference, NATS event, Rust reload, crash recovery.
 */
@Injectable()
export class ActivationService {
  private journal: Activation[] = [];

  activate(tenant: string, commit: string): Activation {
    if (!/^[0-9a-v]{8,64}$/.test(commit)) throw new Error('invalid commit hash');
    const seq = this.journal.filter((a) => a.tenant === tenant).length + 1;
    const a: Activation = { tenant, seq, commit, state: 'activated' };
    this.journal.push(a);
    return a;
  }

  current(tenant: string): Activation | undefined {
    return [...this.journal].reverse().find((a) => a.tenant === tenant);
  }

  list(tenant: string): Activation[] {
    return this.journal.filter((a) => a.tenant === tenant);
  }
}
