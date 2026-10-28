import { ActivationService, ActivationResult } from '../activation/activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';

export interface ActivationActivities {
  verifyCommit(commit: string): Promise<boolean>;
  record(tenant: string, commit: string, requestId: string): Promise<ActivationResult>;
}

export const makeActivities = (dolt: DoltService, journal: ActivationService): ActivationActivities => ({
  verifyCommit: (commit) => dolt.commitExists(commit),
  record: (tenant, commit, requestId) => journal.activate(tenant, commit, requestId),
});
