# Subscriber acknowledgement before mandatory routing

An immediate replacement-plugin call failed once in exact PR #147 CI: `profile-dolt.e2e` enabled a replacement after the host had started, then `auth.prepare` refused because the mandatory replacement had no responder. Other jobs, including the Gallery fix, passed. This document does not claim the historical failure's unique cause: that run has no NATS subscription trace.

The host contained a concrete ordering gap. `doSync()` registered the mandatory route with the core before it called the NATS subscriber setup. A NATS subscribe also queues a wire command; the call's return alone is not an acknowledgement from the server. Immediate calls could therefore select a mandatory route before the responder was visible.

The host now installs the desired subscriptions and awaits `nc.flush()` before publishing their routes. A failed flush rejects synchronization; it is not turned into success. The registry's existing awaited activity synchronization still owns enable completion. No sleep, blind request retry, extra timeout, fallback to the base plugin or weakened mandatory policy is introduced. Existing disabled/unknown-branch fail-closed behavior and the serialized sync chain remain unchanged.

## Evidence

Two deterministic transport-barrier tests fail on the original implementation and pass after the change. They assert that routing is not published and sync does not resolve while subscriber acknowledgement is held; a failed acknowledgement must reject without publishing. These use a transport double, not real packet timing.

A local build and 19 tests passed without skips: those two barriers, five real NATS/core bus-host integration tests and twelve real Dolt profile tests. The profile suite includes immediate replacement activation on a new branch and the post-Apply main-registry call that failed in CI. This is local service evidence, not a distributed failover or live-host proof. Historical root-cause attribution remains bounded as above. No real provider call, deployment or repository setting change is part of this fix.
