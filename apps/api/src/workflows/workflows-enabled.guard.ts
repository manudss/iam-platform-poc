import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';

/**
 * Feature gate for the workflows module: every endpoint answers 403 while the `workflows-iga` plugin is disabled
 * for the tenant (same registry the Plugins page manages). A run already executing when the plugin gets disabled
 * is left to finish (its data stays on its own Dolt branch); no new action is accepted until re-enabled.
 */
@Injectable()
export class WorkflowsEnabledGuard implements CanActivate {
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const tenant = String(req.params?.tenant ?? '');
    const registry = workspaceMode() && this.branches ? await this.branches.get(currentBranch(false)) : this.reg;
    if (!registry.isActive(tenant, 'workflows-iga'))
      throw new ForbiddenException('the Workflows (IGA) plugin is disabled for this tenant: enable it from the Plugins page');
    return true;
  }
}
