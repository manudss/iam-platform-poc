# Real Google Sheet workflow demo

## Status and acceptance bar

This runbook prepares a real integration. The automated contract tests use the installed Activepieces package with intercepted HTTP. They do **not** prove access to a Google account or a successful hosted workflow. Do not label the demo verified until all acceptance checks below have been observed on the selected live deployment and real spreadsheet.

## Scenario (about 5 minutes once configured)

1. Open the private demo spreadsheet, the lyam workflow and Executions side by side.
2. The candidate is fictional: `Martin / Camille / finance / employee`. Start with `process = En cours` and blank `cree`.
3. Change only `process` to `OK` in Google Sheets.
4. While the deployment stays awake, the live-main watcher checks every 60 seconds, at most three rows per workflow per tick. A workflow stored only on a personal branch does not watch anything yet.
5. Watch the text blocks compute `martin.camille` and `martin.camille@lyam.demo`, then create the account and grant the fixed `employee` role on the run's own Dolt branch. Login remains disabled. No message is sent.
6. The final external action writes `cree = ok` into the **real** Google Sheet. This means staged for review, not published on lyam main.
7. Open the run branch's diff: account and role must exist there, and not on main. Review it. Publication remains a separate deliberate Apply action.
8. Wait another watcher interval with the sheet unchanged: no second run. The completed marker must exclude the row.
9. Pause this demo workflow on live main after the test. Keep screenshots and the run id. Never reset a completed candidate and replay it blindly; use a new fictional identity for a repeat demo.

Google writes are outside Dolt and are not undone when a run branch is abandoned. Do not sort, insert or delete sheet rows during a run: this POC targets a physical row number, not a transactional external row identity.

## Google setup

- Use a dedicated Google Cloud service account with no project-level roles and share only this dummy spreadsheet with that account as Editor. Enable the Google Sheets API in its project. No billing upgrade or paid service is needed for this setup.
- Do not enable domain-wide delegation. Leave the optional impersonated user email blank. The service account acts only on files explicitly shared with it.
- Spreadsheet columns in row 1 must be unique and exactly: `nom`, `prenom`, `departement`, `role`, `process`, `cree`. The sample rows are in `data/demo/google-sheet-candidates.csv`; use those fictional rows only.
- The spreadsheet stays private. Do not publish it to the web or share it with everyone.
- Create a managed Google Sheets connection in lyam Connections on a working data branch. Enter the credential through the write-only secret field, never in code, seeds, environment metadata, PR text or chat. The source id and numeric tab id are non-secret metadata.
- Use the explicit read-only Test. Verified must be returned before Save. Apply the connection metadata to live main before the watcher can resolve it.
- A public demo login is not a secure operator boundary for valuable credentials. Use a dedicated disposable key with access only to this fictional sheet. Revoke it after the demonstration.

## Secret-store prerequisite

Real connections fail closed if OpenBao is not configured. The hosted demo now includes an optional, loopback-only, RAM-only OpenBao child process, using the pinned 2.7.2 binary. Its bootstrap root token is revoked; the API receives a scoped, non-renewable 24-hour token for `secret/data/iam/workflow-connections/*`, plus read-only access to the absent optional `secret/data/iam/pg` probe required at API bootstrap. The demo never creates PostgreSQL credentials. The raw OpenBao development output (which contains root/unseal credentials) is never persisted or forwarded.

This is demo infrastructure, not production infrastructure. Restart/spin-down loses credentials; surviving Dolt references then fail closed until the key is entered again. A continuously running demo also needs a restart/re-entry after the scoped token expires. `IAM_DEMO_LOCAL_BAO=0` disables the embedded server. An existing external `IAM_BAO_ADDR`/`IAM_BAO_TOKEN` pair takes precedence. Do not configure only half of that pair.

The extra process consumes memory. The isolated OpenBao security test is automated; the full image and actual free-host memory/startup behavior must still pass CI and a requested deployment before hosted readiness is claimed. No new paid Render service is created.

## Existing demo seed path

The optional real scenario reuses `WorkflowDemoSeed`, enabled only by the existing `IAM_DEMO_DATA_SEED=1`. Supply non-secret metadata:

```
IAM_DEMO_GOOGLE_SPREADSHEET_ID=<real spreadsheet id>
IAM_DEMO_GOOGLE_SHEET_ID=<numeric tab id, often 0>
IAM_DEMO_GOOGLE_CONNECTION_ID=<saved managed connection id>
```

It creates `wf-hr-google-demo` only if absent and **paused**. It never creates a Google credential, overwrites an existing workflow, activates the watcher, or starts a run. Check the managed connection, review the real external action, then deliberately activate the definition on live main. The final write has explicit Real configuration; editor Test always forces Simulation and cannot be used as proof that Google was written.

If configuring interactively instead, duplicate the HR scenario and set the trigger plus final mark action to source `google`, the same spreadsheet/tab and managed connection. Choose Real and confirm for the mark action. Keep the role fixed at `employee`; do not give a sheet editor a route to choose arbitrary privileged roles.

## Automated checks

```
node scripts/plugin-dev-setup.mjs
npm run build --prefix apps/api
(cd apps/api && node --test dist/workflows/google-sheets-contract.spec.js dist/workflows/google-demo-seed.spec.js dist/workflows/external-blocks.spec.js dist/workflows/connections.spec.js dist/workflows/execution-safety.spec.js)
BAO_BIN=/path/to/bao node --test scripts/demo-secret-store.test.mjs
```

The contract checks catch the original real-path defects: missing `CUSTOM_AUTH`, flattened-versus-wrapped rows, dropped physical row ids, header names passed as column letters, and missing header validation. They execute the installed Google piece, with network fixtures and a fictional ephemeral service-account key. They also verify that the managed read-only probe and watcher use the same auth contract.

## Live acceptance evidence (still required)

- [ ] Correct deployment head and real-sheet URL recorded privately.
- [ ] Connection read-only Test Verified, then saved and applied to live main.
- [ ] Ready row observed by watcher; execution id and start/end time recorded.
- [ ] Account and employee role present on run branch, absent from main before review.
- [ ] Google `cree` changed to `ok`; the other cells are unchanged.
- [ ] Unchanged row produces no duplicate run on the next check.
- [ ] Another row with `En cours` stays untouched.
- [ ] Workflow paused after the demo; dedicated Google key revoked when finished.

An unresolved Google login/key, a missing secret store, an unmerged code fix or a sleeping host is a remaining prerequisite, not a successful end-to-end test.

## Reference sources

- Google credential types and direct per-document service-account sharing: https://developers.google.com/workspace/guides/create-credentials
- Google Sheets quotas/pricing: https://developers.google.com/workspace/sheets/api/limits . Standard usage is currently at no additional cost; stay within the published quotas and do not enable paid quota increases.
- Pinned OpenBao image and binary location: https://github.com/openbao/openbao/blob/v2.7.2/Dockerfile . Its dev mode is explicitly not for production.


## Badge templates: preparation checklist

The official badge templates are paused and simulated when instantiated. They do not authorize a real run. Configure and review both graphs before activation:

- Phase 1 ticket uses a configurable `labels` field (comma separated), set to `badge-demo`. Phase 2 filters on the same label. Verify that the Jira create metadata includes the labels field; the installed Activepieces action only sends fields present in that metadata.
- Phase 1 records the durable ticket/account/row correlation, then writes the ticket key to the sheet with the `trace` node, before marking `cree=ok`. The trace column defaults to `ticket` and is editable in that node. It must exist before a real run.
- The final marker column remains configurable on phase 2's `mark` node. Its existing default `badge` is not a decision about a live sheet header. Set it to the header approved for that sheet (for example `badge-fait` when that is what was approved). Do not create or rename other columns by inference.
- The row key defaults to a unique `email` column. Adding that column, selecting an actual recipient and allowing that recipient for secret mail are separate live setup steps requiring approval. The template never hardcodes a real address.
- French ticket/mail text follows the demo plan. The generic mail greeting is `Bonjour` rather than `Bonjour Camille`; the account identifier, validity duration and recorded expiry are substituted at runtime. These adaptations must be included in the exact rendered message shown for approval before sending. The 24-hour default is not an unchanging claim about the expiry.
- No password is stored in a ticket, spreadsheet, graph or output. `[[password]]` and `[[expiry]]` are mail-only markers. The recipient must match the linked account and be explicitly allowed.

These changes update the template catalogue, not workflow definitions already instantiated on a deployment. No spreadsheet write, Jira issue or e-mail is performed by loading the catalogue or running validation tests.

### Target Jira issue type

For the configured demo site, a read-only check of KAN creation metadata on 22 November 2026 found Task = `10003` and the `labels` field available. The badge template uses this site-specific example. The generic Jira create block has no guessed issue-type default. Check the target project metadata and set `issueTypeId` before any real run, especially when reusing the template on another site. This metadata check is not a ticket creation test.

### Stable-key writes, preflight and recovery

The badge templates no longer write using the row number saved by the trigger or an earlier lookup. Both phase 1 writes (`trace`, `mark`) and the final phase 2 marker resolve the unique row key immediately before writing. Missing/duplicate keys or headers stop the write, without positional fallback. Phase 1 begins with a read-only `preflight` node that requires exactly one row and the configured `email`, `ticket`, final-marker and `cree` headers before any account or ticket effect. If you change the key or final marker header in a copied workflow, change the preflight configuration too. A header removed later still fails at write time.

This is NOT an atomic compare-and-set. The installed Google action ultimately writes by row number. Re-resolving the key handles a sort between the trigger and the write, and between failed attempts, but cannot protect against a concurrent sort in the last read/write gap. Keep sorting/row insertion/deletion and manual edits paused during the demo run. Without that operational freeze this integration is not qualified for concurrent editing. Do not describe the flow as fully protected from concurrent Google edits.

After a failed trace, retry the failed step in the SAME persisted run. The successful ticket step and its key remain persisted and are not re-run. Starting a new run is not a safe retry and can create another ticket. An uncertain Jira creation remains held for provider reconciliation by the existing engine guard. A Sheets cell set is repeatable, resolving the key afresh on each attempt.

During first real qualification, inspect the created ticket and confirm `badge-demo` is actually present before expecting the Done watcher. The metadata check and no-network argument test do not prove a provider accepted the label. Do not create a second ticket merely to retry a failed trace.

### Wording and approval boundary

The template is preparation, not evidence of an approved send. Before the first real ticket/mail, review the complete rendered content and approved recipient with the owner. Compared with the plan's example for Camille Martin, the template substitutes the actual first/last name and actual department/role in the ticket, uses a generic mail greeting, inserts the linked account identifier, and displays recorded hours plus exact expiry. The subject remains French. The expiry addition, greeting change and actual column-value substitutions are adaptations, not verbatim approved text. Comments or tests saying the wording follows the plan do not authorize external communication.

Changing these plugin blocks also requires the normal plugin signature generation and deployment checks. No signature, simulation, connection, recipient or publication guard is bypassed by the catalogue changes.

Phase 2 also preflights the stable key and the final output header in `find`, before `gen`, `set`, publication, mail or unblock. Its `requiredColumns` must match the final `mark.column`; phase 1 preflight must include that same final marker header plus its trace and cree columns. The catalogue tests assert this synchronization for the shipped defaults. When editing an instantiated graph, review all these fields together before enabling it; the general graph validator does not infer that two unrelated strings are intended to name the same column. No live column is added by this check.
