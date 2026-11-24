# Native Sheets graph contracts, installed 0.19.5

This is a preparation contract with fictional values, not a published or
live-qualified workflow. Secrets only belong in a managed connection. All
native nodes require selected account-scoped connection, Simulation by default,
and separately confirmed Real mode before effects. PR163 is not required.

Native type IDs are derived from installed native keys and checked into
inventories/google-sheets-0.19.5.json; call sheetBlockType(key) in tests or inspect
the runtime catalogue, never invent a type ID. Outputs are wrapped as
`{result: <unchanged native result>, confirmed: true}`. Simulation returns
`{confirmed:false,dryRun:true}` without reading credentials or calling Google.

## Find Rows, key find_rows

Native config (plus host connectionId/executionMode/realConfirmed):

```json
{"spreadsheetId":"fictional","sheetId":"0","includeTeamDrives":false,"columnName":"A","searchValue":"Camille","matchCase":true,"startingRow":2,"numberOfRows":20,"headerRow":1,"useHeaderNames":false}
```

Native result is an ARRAY of `{row,values}`. With useHeaderNames false, values
keys are letters. With true, upstream maps to header names. Matching is native
case-insensitive substring matching when matchCase=false. Despite its name,
matchCase=true performs an exact case-sensitive equality comparison in installed
0.19.5. Neither mode proves an exact unique selection when numberOfRows caps
the returned matches. A graph must apply its own exact comparisons and count policy.
startingRow defaults to1 and can include the header row, so set2 explicitly for
data beginning at row2. Fixture tests cover the installed action, not a rewrite.

## Get Row, key find_row_by_num

```json
{"spreadsheetId":"fictional","sheetId":"0","rowNumber":2,"headerRow":1,"useHeaderNames":false}
```

Native result is `{found:true,row:2,values:{A:"Camille",B:"OK"}}`, or
`{found:false,row:null}`. It is not an array. Check found before using values.

## Update Row, key update_row

```json
{"spreadsheetId":"fictional","sheetId":"0","includeTeamDrives":false,"row_id":"{{steps.read.result.row}}","first_row_headers":true,"values":"{\"I\":\"{{steps.transform.value}}\"}"}
```

With first_row_headers true, native values is the dynamic letter-keyed object
returned by the native resolver, for example `{I:"OK"}`. Header labels are for
display, not object keys. With false, native values shape is
`{values:["Camille","OK"]}`. The installed action maps empty string/null/undefined
to skipped cells, uses positional row_id and Google USER_ENTERED. It provides
no lock, CAS, unique selection or conditional update. A formula-like value may
be interpreted by Google. Branch abandonment does not undo external writes.
Result is `{updates:<Google update response>,row:<number>}`.

## Generic result paths and typed values

`{{steps.find.result.0.row}}` selects an array index.
`{{steps.read.result.values.A}}` selects a nested key.
`{{steps.find.result.length}}` reads array count. Missing paths fail closed.
Prototype/constructor paths are rejected.

For a native Sheets node with a valid JSON config string containing step/event
placeholders, interpolation parses the JSON container first. Non-native literal
config strings are not parsed or rewritten.
An exact placeholder inside a JSON value retains its source type, including
number, boolean, array or object. Quotes/newlines in strings are JSON-escaped,
not concatenated into JSON source. Mixed strings still interpolate as text.
Native output is never flattened into invented first-level keys.

Generic `json-values` computed block supports get/count/filter-equals:

```json
{"input":"{{steps.find.result}}","operation":"filter-equals","path":"","field":"values.A","equals":"Camille"}
```

Outputs `{value:<selected/filtered native value>,count:<number>}`. It can also
read a parsed event body via input `{{event.data}}` and path `values.A`, or filter
Jira arrays by `fields.status.name`. Use ordinary If blocks for count/found/
process/cree tests. These operations contain no HR/email/badge rules.

## Triggers and loop prevention

The Sheets native New Row and New or Updated Row triggers are WEBHOOK lifecycles
with Google Drive watch/renew/stop; new spreadsheet/worksheet are native polling.
The host emits the unchanged native event object as JSON in event.data, plus
bounded top-level scalar convenience fields. Nested values require json-values.
Host envelope IDs deduplicate recovery of the SAME pending batch. This is not
semantic deduplication of all later Google notifications or self-written rows.
A graph must first test process/cree and its own final markers before any effect;
its Update Row can produce another notification, which must take the no-effect
branch. Live callback delivery and this self-write loop must still be tested
with authorized fixtures. No complete workflow or Jira Done behavior is claimed.

State/secret/file services and uncertain-effect stops are Lyam services, not
Activepieces guarantees. Old spreadsheet-scoped credentials are not broadened
by naming an account-scoped action. New scope needs an operator-managed credential
update and reviewed metadata publication. No secret is included in these examples.

## Qualified native self-write filter contract (fixture transport)

Installed New or Updated Row exposes `trigger_column`. Set it to `E` only AFTER
freshly verifying the real headers and the user's intended process-column rule.
Its native cursor hashes only that column for each positional row. A native
lifecycle test enables the actual trigger, changes E to OK (one row event), then
writes H email, I ticket, F cree and G badge-fait while E stays OK (zero events,
including repeated notifications). A later change of E emits a new event.
This is native column-change filtering, not an invented host semantic dedup.

It prevents the demonstrated intermediate self-write loop ONLY while the watched
E value and row layout stay unchanged. Concurrent edits of E, sorting/insertion,
a new channel baseline, or new activations require independent handling and live
qualification. A paused/assisted one-event demonstration is not an unattended
reusable workflow verdict. Historical real headers supplied by the coordinator
are A nom, B prenom, C departement, D role, E process, F cree, G badge-fait,
H email, I ticket. These are leads to revalidate live, never permission to write
I=OK. Earlier generic I=OK input above is illustrative only, not a demo update.

## Empty cells, absence and complete-read limits
Installed get-many-rows pads each returned row to at least header width, using
empty strings for omitted trailing cells. Header mapping can overwrite duplicate
header names, so verify unique intended headers before using mapped fields.
Fields beyond known headers or absent event properties can still be missing.
Generic json-values now offers exists and an explicit missing=default policy
with defaultJson (for example JSON empty string). Default policy remains error.
Defaults apply to missing paths only, not null, false, zero or present empty text.
Unsafe prototype paths always fail, including with exists/default.

get-many-rows has no number-of-rows limit or pagination in the installed action.
With first_row_headers=true it reads A2:ZZZ through the sheet values API; otherwise
it reads the tab range. It separately reads headers and may reread for mapping,
so this is not a consistent snapshot under concurrent edits. Columns beyond ZZZ
are excluded by the explicit ranged form. Trailing all-empty rows need not appear.
No complete=true flag or total row count is returned. A successful small-fixture
response with both duplicate rows proves only that fixture, not provider-wide
completeness, permissions, response limits or future sheet edits. For assisted
demo selection, stop edits, validate expected headers/data extent, read the whole
known data range and exact-filter all candidates. Never infer uniqueness from a
Find Rows result capped at1 (or any cap that could hide another candidate).
