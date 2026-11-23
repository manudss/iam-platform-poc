# Workflow connectors (Activepieces spike)

The `workflow-connectors` plugin is a **spike**: it proves the IAM platform's workflow engine can expose a
**block catalogue** where each block is backed by a real [Activepieces](https://www.activepieces.com) piece,
and runs a demo scenario end to end without any external credential.

It answers one question honestly: *what works when Activepieces pieces run inside our engine, and what does
not.* See "What the spike proved" below.

## Enabling

The plugin is shipped but **disabled by default**, like every plugin: Plugins page, install then enable.
It requires the **Workflows (IGA)** plugin (`workflows-iga`) to be enabled too: the blocks live in the
workflow editor's palette.

While `workflow-connectors` is disabled on a branch, saving or starting a workflow that uses one of its
blocks is refused (403 with the plugin name), and its webhook and row watcher stay silent.

## The blocks

Each block is a workflow step type contributed on the `workflows.blocks` surface (the plugin manifest's
`entrypoints.blocks`). The editor lists them from `GET /tenants/:t/workflow-blocks`, after the built-ins.

| Step type | Backed by | What is real, what is simulated |
|---|---|---|
| `http-request` | `@activepieces/piece-http` | **Real HTTP call.** Every destination host must be explicitly allow-listed in plugin settings. Redirects are not followed. In a dry-run step, logs the call and sends nothing. |
| `text-transform` | `@activepieces/piece-text-helper` (+ native `lower`/`unaccent`) | Pure computation. `concat`, `replace`, `slugify`, `find`, `split` run through the piece; the piece has no lowercase/unaccent, so those two are native additions. |
| `google-sheets-read` | `@activepieces/piece-google-sheets` | Source `demo-sheet` reads the built-in **SIMULATED** sheet (no credential). Source `google` makes a **real API call** once a service account is configured. |
| `google-sheets-update` | same piece | Writes one cell. On the demo sheet the write is simulated; with source `google` it is a **real external write, not reverted** by abandoning the run branch. |
| `google-sheets-add-row` | same piece (`insert_row`) | Appends one row (`column = value` lines). **Not idempotent** (the piece says so itself): a retried step would append again — the engine only retries failed steps, and a done step never re-runs. |
| `jira-search-issues` | `@activepieces/piece-jira-cloud` (`search_issues`) | Read-only JQL search. `dryRun` on (default) only logs the query; a real search needs the Jira settings. |
| `jira-create-issue` | `@activepieces/piece-jira-cloud` | `dryRun` on (the default) only logs the issue it would create. With `dryRun` off and the Jira settings filled, a **real issue is created** — retrying creates another one. |
| `lyam-create-user` | native (this platform) | **Real data write on the run branch only**: inserts the identity with login disabled. Idempotent: a retried step adopts the existing branch row. Publishing stays the human review/merge. |
| `lyam-block-account` | native (this platform) | **Real and immediate**: sets an account block (type and the message shown at sign-in, optional automatic end). It is operational state, not a branch write, so it is not reviewed or reverted with the run; the definition itself was reviewed. A test run only logs. Idempotent (a block of the same type already in force changes nothing, so a workflow started by `user.blocked` cannot loop). The last active administrator is never blocked. |
| `lyam-unblock-account` | native (this platform) | **Real and immediate**: lifts the blocks of an account (all, or one type). A test run only logs. |
| `lyam-security-setting` | native (this platform) | **Real data write on the run branch only**: changes one security setting (lockout, administration level, application level, hold after verification), checked like the settings screen. Live after the normal review and Apply. If it raises the administration level to one no sign-in chain can reach, the level is simply not applied, so the administrators are not locked out. |

Step outputs are usable downstream as `{{steps.<step id>.<key>}}` (e.g. `{{steps.lower.value}}`); each block
documents its output keys, and the model refuses references to unknown or later steps at save time.

## The triggers

| Event | Starts when |
|---|---|
| `http.webhook-received` | A caller posts JSON to `POST /tenants/:t/workflow-hooks/<workflow id>/<token>`. The endpoint is public: the per-workflow token in the path (12+ characters, chosen in the trigger config) is the credential, compared in constant time. Top-level scalar body keys become `{{event.<key>}}`; an optional `"_dedupe": "<stable id>"` makes repeat posts start the same run instead of a new one. |
| `google-sheets.row-ready` | The **row watcher** (every minute, definitions on LIVE only) finds a sheet row whose watch column equals the ready value and whose done column is not yet the done value. Row values become the payload (`{{event.nom}}`, `{{event.rownumber}}`, …). One deduplicated run per row content; at most 3 rows per definition per tick. |

## The demo scenario (seed `wf-hr-onboarding`)

With the demo seed (`IAM_DEMO_DATA_SEED=1`), the workflow *HR: a candidate row provisions the account*
watches the built-in **simulated** candidates sheet (*Candidats RH (démo simulée)*, columns
`nom, prenom, departement, role, process, cree`). For each row with `process = OK`:

1. builds `nom.prenom` (Activepieces `concat`), strips accents (`unaccent`), lowercases it;
2. builds the e-mail `nom.prenom@lyam.demo`;
3. creates the user through the `lyam-create-user` block (real, on the run branch);
4. grants the role named in the row's `role` column (real, on the run branch);
5. marks the row `cree = ok` on the sheet, so the watcher does not pick it again;
6. informs HR (`notify`, simulated — only a log line, as always).

The run stops on its own `wf-<run>` branch; a human reviews and merges, like any workflow run. The demo
sheet is readable and editable through the plugin routes `GET/POST/PUT /tenants/:t/plugins/workflow-connectors/demo-sheet*`
(the console shows it in the workflow editor), and it resets to its seed rows on restart.

Two more seeds show the other triggers: `wf-leaver-jira` (user.disabled → Jira ticket + search, both dry-run
until a sandbox token is configured) and `wf-candidate-intake` (public webhook
`/tenants/<tenant>/workflow-hooks/wf-candidate-intake/demo-intake-token` — a documented demo-only token, change
it — appends the posted candidate to the simulated sheet with process "En cours").

## Settings (typed in the console, never in code)

| Setting | Secret | Purpose |
|---|---|---|
| Jira instance URL / e-mail / API token | token | Real `jira-create-issue` (a Jira sandbox site is enough) |
| Google service account JSON key | yes | Real `google` sheet source; share the spreadsheet with the service account's e-mail |
| Google user e-mail | no | Optional domain-wide delegation user |
| HTTP block: allowed hosts | for HTTP calls | Exact destination hosts; empty refuses all calls. Add only trusted hosts, especially for local/private services |

Secrets are plugin settings of type `password`: they never come back out of the API, and the block receives
them at run time only. Without them the corresponding blocks fail with a message saying exactly what to type
where — they never silently simulate.

## What the spike proved

- **Pieces run standalone.** An Activepieces piece action executes outside the Activepieces server with a
  hand-built context (four pinned packages, ~20 MB installed). The HTTP piece made a real request in the
  probe; the text-helper operations return plain values.
- **Auth is per-piece, not per-platform.** Jira wants an instance URL + e-mail + API token, Google Sheets a
  service-account JSON key. The spike maps them onto plugin settings; a general "connections" UI like
  Activepieces' own does not exist here and would be its own project.
- **Piece contracts are internal.** Property names (`first_row_headers`, `issueFields`, …) are not a
  documented public API: the adapter pins exact package versions and the unit specs pin the behaviours the
  blocks rely on (a piece upgrade that changes them fails the build, not the demo).
- **Triggers are ours.** Activepieces triggers are tied to its app runtime (webhook URLs, polling
  scheduler); the spike keeps trigger lifecycle in the core (public webhook route, 60 s watcher), the piece
  only does the API talk.
- **External effects and branch isolation do not mix.** A real sheet write or Jira issue is outside Dolt:
  abandoning the run branch cannot undo it. The UI and the step logs say so on every concerned step, and the
  Jira block ships with `dryRun` on.

## Limits of the spike (not done, on purpose)

- The row watcher polls definitions on **LIVE (main) only**, every 60 s, at most 3 rows per tick.
- No retry/backoff policy inside the HTTP block beyond the piece's own; a failed step is retried by the
  engine's usual retry.
- The demo sheet is in-memory: a restart resets it.
- No Activepieces connection testing ("test your settings" button) yet: a block tells you at run time.

### Hosted demo / workspace mode

The opt-in fictional-data seed enables `workflow-connectors` with the other demo plugins. Background
sheet watches and public webhooks explicitly use the **main** branch registry and context, not a
visitor's personal branch. To change the live configuration, edit it on your personal branch and use
Review and apply changes. This is a Dolt data publication, not a GitHub merge.

The hosted edge prefixes API routes with `/api`: the intake URL on a Render preview is
`/api/tenants/acme-demo/workflow-hooks/wf-candidate-intake/demo-intake-token`.
Never treat this public demo token as suitable for production. No Google/Jira credentials are seeded.

Editor additions: block search, duplicate a step (without links), read-only definition JSON,
and per-step outputs in the run view. Placeholder examples are reference chips, not automatic field insertion.

### Guarded updates using the existing generic cell block

`google-sheets-update` remains the shared component for emails, ticket references,
status markers such as `OK`, and any other nonempty cell value. It delegates to
the installed Activepieces Google Sheets `Update Row` action. There is no
email-specific block or embedded candidate/status rule.

Existing positional and unique-key configurations remain compatible. For controlled
assisted-demo processing, set `checked=true` on **every** write, including the
initial email, ticket trace, `cree`, and `badge-fait` markers. Checked mode requires
a managed Google source. It adds:

- Selection: existing `keyColumn` / `keyValue`, OR up to four flat
  `matchColumn1..4` / `matchValue1..4` pairs. At least one selector value must
  be nonempty. All comparisons are exact strings. The selector must identify
  exactly one row before preconditions are considered.
- Preconditions: up to four independent `checkColumn1..4` / `checkValue1..4`
  pairs, compared against the fresh row. A missing value means empty string.
  A precondition on the target column also accepts the new value, allowing
  verified same-value continuation without rewriting.
- `column` and `value`: generic target and nonempty value to write.
- `requireExpected=true`, `expectedValue`: refuse a target cell different from
  that expected value or the new value. Expected may be empty. An already-equal
  cell returns without a second write.
- `uniqueValue=true`: refuse the new target value in another row of that column,
  using case-insensitive, trimmed collision comparison.
- `requiredColumns`: optional additional unique headers, comma separated.

Flat values accept event/step placeholders without parsing interpolated JSON.
Quotes, backslashes and spaces in source fields remain literal. Do not substitute
an event field that the poller omitted: an absent optional source field can be
configured as an explicit empty value instead.

Example workflow configuration, not a built-in rule: match `nom`, `prenom`,
`departement`, `role`; require `process=OK` and empty `cree`, `ticket`, `badge-fait`;
write the workflow-calculated address to `email` with `requireExpected=true`,
empty `expectedValue`, and `uniqueValue=true`. Downstream steps use the returned
`value`, never the originally empty trigger email. Subsequent updates select
by this recorded email, change `column`/`value`, and use their own workflow
preconditions. The block itself knows nothing about these field names.

Checked mode reads twice, requiring unique headers, one matching source and
unchanged complete source values. A row that moved before the final read is
resolved again. Only the requested cell is written. Fresh readback verifies the
same source, headers, complete row, and target value. Returns
`updated=true, value=<verified value>, written=true`, or `written=false` for an
already-equal verified target. Simulation has no provider calls and returns
`updated=false, dryRun=true`. Activepieces uses USER_ENTERED values; clearing a
cell is not supported here and a formula/calculated result differing from the
requested literal fails readback rather than claiming literal storage.

This is **not atomic, not a row lock and not compare-and-swap**. Google updates
remain positional, including a race after the last read. The operator must stop
sorting/editing until candidate processing finishes. Do not treat the declared
single-editor demo scope as a technical concurrency guarantee.

Immediately before the checked write the engine saves an external-effect review
marker, not before readonly validation. A lost response, write failure, readback
mismatch or crash before saved step completion stops the run for review. Retry
and error routes cannot bypass the marker. Reconcile provider and downstream
state before a deliberate recovery. A fresh invocation can recognize an already
equal value without another write only if selection and preconditions still
match. This does not authorize adopting an old account/ticket. Legacy unchecked
updates retain their prior behavior; they do not silently gain these guarantees.
