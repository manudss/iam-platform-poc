# IGA closing evidence digest

New closing evidence records `digestFormat: sha256-json-sorted-keys-v1`.
Verification replaces `digest` with null, recursively sorts object keys (array order is preserved), serializes compact JSON, and hashes its UTF-8 bytes with SHA-256. SQL JSON column key ordering does not change the hash.

On workflow reentry, a versioned proof must match the campaign id, workflow actor and recalculated digest before being adopted. Another actor's closure is never adopted. A concurrent close can only have one winner in storage.

Older evidence has no digestFormat. Its original digest was calculated on insertion-order JSON, before SQL potentially reordered keys. It is preserved unchanged, not migrated or silently recalculated. Reentry accepts the historical stored proof only for its own recorded actor with a nonempty digest; this is actor correlation, not cryptographic re-verification of the old JSON. Unknown explicit formats fail closed. This does not authenticate database administrators or protect against an authorized writer rewriting both content and hash.

Tests use real local Dolt, a fresh WorkflowStore, the actual close block, a nested item/remediation, nonempty role drift, independent hash recomputation and concurrent closes. They do not claim process-kill recovery or Oracle deployment qualification.
