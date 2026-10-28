import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ActivationService, ActivationResult } from '../activation/activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';
import { makeActivities } from './activities.js';

/**
 * Runs activations as Temporal workflows when IAM_TEMPORAL_ADDR is set (in-process worker, task queue iam-activation).
 * POC scope: single in-process worker, namespace "default", no TLS/auth, no signals/queries/versioning.
 */
@Injectable()
export class TemporalService implements OnModuleDestroy {
  private readonly log = new Logger('temporal');
  private worker?: Worker; private running?: Promise<void>;
  private client?: Client; private conns: { close(): unknown }[] = [];

  constructor(private readonly dolt: DoltService, private readonly journal: ActivationService) {}

  get enabled() { return !!process.env.IAM_TEMPORAL_ADDR; }

  async start() {
    const address = process.env.IAM_TEMPORAL_ADDR!;
    const nc = await NativeConnection.connect({ address });
    const conn = await Connection.connect({ address });
    this.conns.push(nc, conn);
    this.client = new Client({ connection: conn });
    this.worker = await Worker.create({
      connection: nc, taskQueue: 'iam-activation',
      workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
      activities: makeActivities(this.dolt, this.journal),
    });
    this.running = this.worker.run().catch((e) => this.log.error(`worker stopped: ${(e as Error).message}`));
  }

  async activate(tenant: string, commit: string): Promise<ActivationResult> {
    if (!this.client) await this.start();
    return this.client!.workflow.execute('activationWorkflow', {
      taskQueue: 'iam-activation', workflowId: `activation-${tenant}-${randomUUID()}`, args: [{ tenant, commit }],
    });
  }

  async onModuleDestroy() {
    this.worker?.shutdown(); await this.running;
    for (const c of this.conns) await c.close();
  }
}
