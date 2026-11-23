# Badge directory login enablement

The official badge request template creates a disabled directory identity. Setting a temporary credential deliberately does not enable a disabled login. Removing the operational suspension also does not change that versioned flag. The old badge done graph could therefore publish a valid temporary credential, send its mail, and finish with an unusable directory account.

The badge done template now explicitly runs `lyam-set-login-enabled` after setting its temporary credential and before publishing that branch. The creation run's suspension remains in force through publication and mail acceptance. Only the existing owned-unblock step lifts it. The generic temporary-password action, ordinary disabled-account behavior, reset freeze, publication allow-list and mail guards are unchanged.

The enablement validator now accepts its own normalized boolean result. Graph validation runs again on an already validated graph; the old yes/no-only validator refused `true` during this round trip before the first engine step.

## Evidence and limits

- A regression using the real create block, real isolated Dolt, real UsersService and selected official template steps was red on the old graph specifically at directory authentication after merging the temporary credential. It becomes green with explicit enablement. It also checks the forced first-access state, completes the first-access change, rejects the old temporary credential and accepts the replacement. Plain local Dolt merge is used here, not the WorkspacePublisher or real activation.
- The existing real-engine badge suite keeps its store/users/accounts/workspace/mail doubles and Sheets substitutions. Its nominal sequence now includes explicit enablement, and its adverse/replay/crash cases remain covered. It is not a live provider or whole-demo proof.
- The validator round-trip test checks both yes/true and no/false.
- New template instances receive this step. Existing stored workflow definitions are not silently migrated. An authorized operator must inspect their actual graph and make the reviewed change before the real demo.

No deployment, external account, real Jira/Google write or mail send is performed by these tests. Mail provider acceptance is not delivery proof. The whole two-phase provider journey and real sign-in/first-access flow remain separate acceptance work.

## Whole local graph integration

`badge-whole-local.spec.ts` runs both unmodified official graphs, with only managed connection IDs, confirmation flags and the fictional spreadsheet ID filled in. No Sheets or Jira node is replaced. Both pollers and the installed Activepieces actions run against intercepted Google/Jira HTTP fixtures. The engine, Dolt business and meta stores, correlation/claim/completion, UsersService, account BlockStore/effects, WorkspacePublisher, ActivationService and local Rust core/NATS are real. The publication allow-list wrapper and its live proof are exercised. Directory profile/password-policy validation and managed-connection resolution are fixtures; mail acceptance is a transport double, not Resend or inbox delivery. Activation uses the local in-memory journal, not production PostgreSQL.

The test follows ready row, disabled identity publication, owned suspension, Jira ticket, sheet ticket/cree updates, Jira Done, correlated claim, temporary credential, explicit directory enablement, publication/activation, mail acceptance while still suspended, owned unblock, badge sheet update and completed correlation. It then authenticates through UsersService, performs the forced first-access credential change, rejects the temporary credential and accepts the replacement. It checks that the password is absent from persisted run/step state and the credential file. A completed row is no longer ready; replaying the completed ticket fails before password generation/publication/mail and makes no extra sheet/Jira effect.

This closes a local whole-graph integration gap, not the live demo acceptance gap. It does not exercise production settings, real provider permissions/results, delivery, HTTP/browser sign-in, a cold restart or distributed concurrency. No real recipient or account is used.
