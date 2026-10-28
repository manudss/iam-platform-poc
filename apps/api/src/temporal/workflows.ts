// Workflow code runs in Temporal's deterministic sandbox: only import @temporalio/workflow and types.
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { ActivationActivities } from './activities.js';

const retried = proxyActivities<ActivationActivities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } });

export interface ActivationInput { tenant: string; commit: string; requestId: string }

/** Activation of a Dolt commit for a tenant: verify the commit is on main (retried), then journal + core apply + event. record() is idempotent per requestId, so it can be retried safely. */
export async function activationWorkflow(input: ActivationInput) {
  if (!(await retried.verifyCommit(input.commit))) throw ApplicationFailure.nonRetryable(`commit ${input.commit} is not on Dolt main`, 'CommitNotOnMain');
  return retried.record(input.tenant, input.commit, input.requestId);
}
