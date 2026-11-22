# Durable direct-child join

`lyam-join-child-run` is a separate block from the existing bounded `lyam-await-run`. It accepts the ID returned by `lyam-start-workflow` and a deadline in hours, up to 720. It only joins an existing direct child of the current parent in the same tenant. It does not adopt arbitrary runs, start another child, cancel a child, or expose the child's step outputs.

The block stores a `child-run` wait payload in the existing durable step input: child ID and one absolute deadline. Subsequent passes use that exact deadline, never extend it. A pending child parks the parent on its normal waiting state. The regular scheduler tick reconciles persisted child waits and kicks the normal engine when the child is terminal, missing, no longer a direct child, or the deadline expires. Boot recovery also rechecks waiting parents. A failed/canceled/missing/foreign/expired child fails the join, rather than reporting completion. A completion first observed after the deadline is refused conservatively, even if it may have happened earlier.

The existing bounded polling block is unchanged. No new automatic publication, account operation or approval is introduced. Generic durable-wait log wording now covers both child conditions and human tasks.

## Evidence

`child-join.spec.ts` covers tenant/parent binding, self/non-child/missing refusal, deadline preservation, malformed saved state, child failure/cancellation/expiry, simulation without reads, real suspension and the read-only scanner's kick conditions.

The real-Dolt workflow API integration suite adds failure/cancellation/expiry/non-child paths and extends its real Nest application restart journey: parent starts one child, child waits on a real durable human task, parent parks on the child, the whole application closes/reopens over the same Dolt, the absolute join deadline remains unchanged, a human decides the child task and the ordinary scheduler tick resumes the parent. The original start step and following step execute once. HTTP authentication is the suite's existing fixture guard; the real AdminGuard, local core/NATS and Dolt run normally.

## Limits

This is local single-process application restart evidence, not cold Dolt/host restart, multi-replica execution ownership or distributed failover. The scheduler scans persisted running/waiting runs; it is not an indexed push subscription or a performance proof for a large estate. Checks occur on the normal scheduler cadence and may be delayed by an unavailable store or disabled/unresolved engine. Read errors do not create a success. Parent cancellation leaves a child independent. Timeout does not cancel the child or settle its human tasks. A human must decide what to do with those remaining children.

The wider signup finalization/durability gap, secured reset freeze, external entitlement reconciliation and real provider/demo acceptance remain open. This change makes no live-provider claim and changes no deployment state.
