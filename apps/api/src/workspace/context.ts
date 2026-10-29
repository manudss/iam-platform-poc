import { AsyncLocalStorage } from 'node:async_hooks';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { branchName } from '../versioning/guards.js';
export const applyContext = new AsyncLocalStorage<boolean>();
export const branchContext = new AsyncLocalStorage<{ branch?: string }>();
export const workspaceMode = () => process.env.IAM_WORKSPACE_MODE === '1';
export function currentBranch(write = false) {
  if (!workspaceMode()) return 'main';
  const branch = branchContext.getStore()?.branch;
  if (!branch) throw new BadRequestException('Choose a working data branch before using administration');
  branchName(branch);
  if (write && branch === 'main') throw new ForbiddenException('main is read only. Choose a working branch, then Apply when ready.');
  return branch;
}
