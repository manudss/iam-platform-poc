import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** gRPC client for iam.decision.v1.Decision (proto/decision.proto at the repo root). Plaintext: loopback / private network only (POC). */
const PROTO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../proto/decision.proto');

export interface DecisionResult { allow: boolean; reasons: string[]; errors: string[]; version?: { seq: number; commit: string } }
interface Client { Decide(req: object, opts: { deadline: Date }, cb: (e: grpc.ServiceError | null, r?: { allow: boolean; reasons: string[]; errors: string[]; commit: string; activation: string | number }) => void): void; close(): void }

export class CoreGrpc {
  private client: Client;
  constructor(addr: string) {
    const def = loader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
    const pkg = grpc.loadPackageDefinition(def) as unknown as { iam: { decision: { v1: { Decision: new (a: string, c: grpc.ChannelCredentials) => Client } } } };
    this.client = new pkg.iam.decision.v1.Decision(addr, grpc.credentials.createInsecure());
  }
  decide(body: { tenant?: string; principal: string; action: string; resource: string; context?: Record<string, unknown> }, timeoutMs = 3000): Promise<DecisionResult> {
    const req = { tenant: body.tenant ?? '', principal: body.principal, action: body.action, resource: body.resource, context_json: JSON.stringify(body.context ?? {}) };
    return new Promise((ok, ko) => this.client.Decide(req, { deadline: new Date(Date.now() + timeoutMs) }, (e, r) => {
      if (e || !r) return ko(e ?? new Error('empty gRPC response'));
      const out: DecisionResult = { allow: r.allow, reasons: r.reasons, errors: r.errors };
      if (r.commit) out.version = { seq: Number(r.activation), commit: r.commit };
      ok(out);
    }));
  }
  close() { this.client.close(); }
}
