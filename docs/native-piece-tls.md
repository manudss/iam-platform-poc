# Native piece TLS correction, offline qualification

Installed Google Sheets0.19.5, Jira Cloud0.6.4 and HTTP0.13.2 bundles each set
NODE_TLS_REJECT_UNAUTHORIZED=0 at sendRequest entry. Text Helper0.6.7 does not.
The main adapter loads these versions too, so this predates the full catalogues.
This is a code-level security defect; no observed data leak is claimed.

The adapter now loads only reviewed SHA256/version-pinned bundle bytes. Before
compilation, it removes the one exact reviewed assignment in each affected
bundle (zero occurrences for Text Helper). Unknown hashes/versions/occurrences
or remaining TLS-control names fail closed. The original module is never loaded
or executed. No environment restoration or insecure concurrency window exists.
An already cached external module is refused. Disabled TLS environment at adapter
load or action invocation is refused, not silently repaired. A running process
already contaminated requires operator assessment; this patch does not restart
anything or claim to repair that process.

Static require inventory: Sheets, Jira and HTTP bundles depend only on Node
builtins. Text Helper additionally has optional jsdom; that dependency is now
refused pending separate review. A runtime require gate permits only Node
builtins for all four reviewed modules, blocking computed/unlisted externals
as well. Consequently Text Helper operations requiring jsdom are unavailable,
not silently covered by this qualification. Bundled code is covered by the
exact source hash, not merely its package version. Upgrades need renewed source
review, hashes, occurrence counts and tests. This does not make arbitrary native
code a security sandbox or prove every operation safe.

Tests create a real self-signed HTTPS server. Certificate rejection is checked
before, during eight parallel requests alongside mocked native Sheets/Jira
calls, after those calls, and after native HTTP attempts that same server.
Server handler sees zero successful TLS requests and environment is unchanged.
Mutation coverage for hash/version/occurrences and independent execution remain
required before deployment qualification. No live provider credentials or host
changes are part of this test.
