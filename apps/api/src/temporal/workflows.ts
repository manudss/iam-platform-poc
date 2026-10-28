// Workflow code runs in Temporal's deterministic sandbox: only import @temporalio/workflow and types.
import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { ActivationActivities } from './activities.js';

const retried = proxyActivities<ActivationActivities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } });
// record() is NOT idempotent (it allocates a new journal seq): never retried automatically.
const once = proxyActivities<ActivationActivities>({ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 1 } });

export interface ActivationInput { tenant: string; commit: string }

/** Activation of a Dolt commit for a tenant: verify the commit is on main (retried), then journal + event (once). */
export async function activationWorkflow(input: ActivationInput) {
  if (!(await retried.verifyCommit(input.commit))) throw ApplicationFailure.nonRetryable(`commit ${input.commit} is not on Dolt main`, 'CommitNotOnMain');
  return once.record(input.tenant, input.commit);
}
