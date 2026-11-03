import { ModuleRef } from '@nestjs/core';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { ActivationService } from '../activation/activation.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { WorkspaceController } from './workspace.controller.js';
import { branchContext } from './context.js';
import { SOD_SQL } from '../dolt/dolt.service.js';

/** Human PR merges use exactly the same serialized, checked publication path as Apply. */
@Injectable()
export class MainPublication implements OnModuleInit {
  constructor(private readonly v: VersioningService, private readonly prs: PullRequestService,
    private readonly activation: ActivationService, private readonly registries: BranchRegistries,
    private readonly modules: ModuleRef) {}
  onModuleInit() {
    this.prs.mainPublisher = async (tenant, source, sub) => {
      const head = (await this.v.branches()).branches.find(b => b.name === source)?.commit;
      const result = await branchContext.run({ branch: source }, () => this.modules.get(WorkspaceController, { strict: false }).apply(
        { confirm: true, expectedHead: head }, { user: { sub: String(sub) } }, tenant));
      if (!result.applied) throw new Error('Data merged but permission activation failed. Retry Apply before closing this PR.');
      return { commit: result.commit };
    };
  }
  /** Called by the API launcher before listen, not by unrelated module test harnesses. */
  async start() {
    if (process.env.IAM_AUTO_ACTIVATE_MAIN === '0' || !this.activation.applyEnabled) return;
    const head = (await this.v.branches()).branches.find(b => b.name === 'main')?.commit;
    if (!head) throw new Error('Automatic activation requires main');
    // Fail closed: never publish a startup snapshot with SoD or constraint violations.
    await this.v.at('main', async c => {
      const [violations] = await c.query(SOD_SQL);
      if ((violations as unknown[]).length) throw new Error('Automatic activation refused: Separation-of-Duties violations');
      const [constraints] = await c.query('select * from dolt_constraint_violations');
      if ((constraints as { violations: number }[]).some(r => Number(r.violations) > 0)) throw new Error('Automatic activation refused: constraint violations');
    });
    this.registries.drop('main'); await this.registries.get('main');
    const tenant = process.env.IAM_TENANT ?? 'acme-demo';
    const response = await fetch(`${process.env.IAM_CORE_URL}/v1/version?tenant=${encodeURIComponent(tenant)}`);
    if (response.ok) {
      const current = await response.json() as { commit: string };
      if (current.commit === head) return;
    } else if (response.status !== 404) throw new Error(`Cannot check active main: HTTP ${response.status}`);
    const result = await this.activation.activate(tenant, head, undefined);
    if (result.state !== 'applied') throw new Error(`Automatic main activation failed: ${result.error ?? result.state}`);
  }
}
