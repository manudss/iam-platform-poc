# Native Jira Cloud, installed 0.6.4

Implementation branch is stacked on the Google Sheets runtime foundation, not
an alternative copy. No legacy workflow or trigger is rewritten or activated.
77 actions and 9 polling triggers are registered from the installed package.
Native keys, properties and result shapes are preserved; native action results
are wrapped as {result: nativeResult, confirmed:true}. The host adds managed
connection selection, explicit Real confirmation and Simulation with zero calls.

## Runtime

The existing durable native scheduler now dispatches by provider. The same
per-definition mutex, staged native cursor/envelope, pending delivery and event
ID recovery apply. A persisted Jira subscription records provider=jira, so its
teardown still uses Jira if its definition is deleted or changed to another
provider. Reserved lyam: store keys are refused. Existing Sheets subscriptions
without provider retain their old behavior. Jira triggers poll on the existing
60-second scheduler; no webhook registration or faster live poll is introduced.
No lease or worker lock expires automatically. Uncertain lifecycle/effects stop
for operator review. Native actions execute under durable per-node locks; writes
mark effect intent inside the lock before the native call. Unknown actions are
conservatively treated as writes. No uncertain write is automatically replayed.

## Updated Issue Status is not a Done event log

updated_issue_status uses native timeField=updated for search and
statuscategorychangedate for its emitted event epoch. It detects status CATEGORY
changes, not every same-category status transition. onEnable sets pollingState
floor/windowStart to current time, without emitting existing matching issues.
Existing Done issues whose category epoch is before enable are not emitted.

Native polling strips trailing ORDER BY from the supplied JQL, optionally
sanitizes that filter with /jql/sanitize, adds updated > relative-time and
ORDER BY updated ASC, then requests /search/jql. It fetches up to 10 pages of
1000, following nextPageToken. Cursor overlap is 15 minutes and dedupe retention
is bounded to 2000 entries. This is native behavior, not an exhaustive event log.
The returned issues are those matching the filter at read time. An issue leaving
Done will not be visible to a JQL restricted to Done. An issue entering the
filter without a new category epoch can also be omitted. Current state and
permissions can hide intermediate transitions. Full truncation/backlog guarantees
are not proven by the two-page fixture.

The native event is the CURRENT issue plus _dedupe_key=issueId:categoryEpoch.
It includes key/id/fields.project/fields.status/fields.labels only as returned by
Jira (*navigable search fields); no oldStatus/newStatus pair or changelog is
synthesized. Same epoch repeats are suppressed. A later category epoch emits a
new current issue. The host event.data is a JSON string of that unchanged object,
with scalar top-level keys also exposed; nested fields should be decoded with
generic json-values. Re-read the current issue when payload fields are absent.

For a badge completion graph, check current project, label and Done explicitly
BEFORE claiming a server correlation. A JQL filter is not identity authorization.
The beneficiary comes only from the existing server ticket link, never summary,
description, reporter, assignee or caller email. Same-category custom Done status
movement may require a different native trigger, such as Updated Issue plus an
explicit graph comparison. Do not rename Updated Issue Status as Done.

## Create Issue and metadata

create_issue requires projectId, issueTypeId and dynamic issueFields. Its native
implementation reads /issue/createmeta/<project>/issuetypes/<type>, formats only
supported metadata fields, POSTs /issue and GETs the created issue by returned id.
The final return is that issue, not merely the initial create response. key is
therefore result.key; self is an API resource URL, not a guaranteed browse link.
Do not invent a browse link from a gateway hostname.

The metadata fixture offers summary, description and labels. Description plain
text becomes ADF; labels are an array. adfFields selects fields already encoded
as ADF JSON. Actual field availability and required fields depend on the live
project/type/screen/permissions. No assumption that the live project offers
labels or description is established by a fixture. A lost create/readback reply
can follow a successful POST, so stop for review, do not issue a second creation.

get_issue_transitions returns actual transitions for an issue. Choose their IDs,
never infer an ID from a status name. transition_issue sends that selected ID once,
then GETs the issue. Failure of readback leaves an uncertain external effect.
Tests prove no second POST in that single invocation, not live workflow policy.

## Correlation continuity

The existing link/resolve/complete primitives index tenant + connectionId +
project + issueKey. Native action type hashes do not change that index. A new
connection ID is NOT an alias for jira-kan; the graph must use the exact managed
connection ID on create, link and later resolve/complete. Do not migrate or copy
correlations silently. Phase-1 run provenance, account owner and owned-unblock
checks remain server-side. Changes to these guards need separate review.

## Security and qualification gaps

Custom API calls are restricted to the bound Jira API root, refuse redirects,
authentication headers, method override headers and query authentication.
All supplied FILE values are native JSON {filename,base64}; they are bounded by
the existing config limits, not fetched from arbitrary user URLs by the adapter.
Installed upstream attachment paths request redirects, and one action uses a
provider-returned content URL. No leak was observed: this was a code-level risk.
A scoped AsyncLocalStorage transport guard now checks every native Jira fetch,
including property resolution and trigger lifecycle, against the bound API root,
and forces manual redirects then refuses every 3xx. Foreign content/CDN URLs are
therefore refused, not downloaded. Unrelated concurrent requests are unchanged.
These are intentional compatibility limits. This process-wide wrapper and async
scope isolation need independent review; no complete-catalogue safety claim is
made from two transport fixtures. Native package upgrades must requalify that
its HTTP paths still pass through fetch; any replacement of the guard fails
closed at native entry.

Evidence: exhaustive action/lifecycle dispatch uses doubles; representative
installed-package HTTP-intercepted tests cover baseline/category epoch/repeats,
sanitation+pagination, create metadata/ADF, transitions and uncertainty. No live
Jira account, actual project metadata, workflow transitions, real scope, provider
rate limits or full badge workflow has been qualified. No provider effects,
connection changes, activation, merge or deployment were performed.
