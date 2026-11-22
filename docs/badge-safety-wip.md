# Badge safety: isolated work in progress

Base: cumulative PR 135 at `90a46150e1cb7dc73b7e2807c9f3e6a3979aa0b5`.
This branch is not the qualified cumulative head. Do not merge or run real badges from it.

## Implemented first slice: identity creation provenance

`lyam-create-user` now requires the tenant/run/node supplied by the engine, never a configurable ownership field. A nullable internal `workflow_creation_ref` column stores the digest of that execution tuple and identity. The marker and identity are written in the same INSERT on the run branch.

An existing identity is reusable only when its marker matches this execution. A historical unmarked identity is ambiguous and fails closed, even if a previous release may have created it. There is no automatic backfill or adoption. Such older runs need explicit reconciliation outside this patch. Refusal happens before schema or data writes. A same-execution retry returns the stored email, not a newly requested address.

This is lineage under the existing trusted database/operator boundary, not a signature against an operator who can directly rewrite database rows. No new authentication mechanism or secret is introduced. UsersService.list projects explicit public fields and does not include this marker. No editor field or graph is added. The badge templates and generic temporary-password approval behavior are unchanged.

Local checks for this slice: TypeScript build; 12 provenance tests with row doubles plus 17 existing external-block tests; 3 real-Dolt tests through VersioningService.writeOn; 4 existing connector HTTP/engine tests with real Dolt, core and NATS, fictional data and controlled external targets. The three Dolt cases cover persisted same-run retry, foreign historical refusal with unchanged root/schema, and failure before commit resetting both identity and schema before retry. This does not qualify publication/activation with the additional identity column or the complete badge journey.

## Still required before review of the complete safety lot

- Read-only mail/publication feasibility and authority preflight from main before account creation and before correlation claim.
- Correlation peek without mutation, early identity/email/sole-owned-block checks, then atomic claim and retained final guards.
- Re-read current main mail policy at the final send, without a fallback or retry of unknown delivery.
- No approval added to the generic temporary-password node.
- Isolated early-failure/resume tests for those guards, full combined tests and independent review. No CI qualification or real delivery is claimed yet.

No real mail, badge execution, external account, merge, deployment, dispatch, host, queue or pause action was performed for this slice.
