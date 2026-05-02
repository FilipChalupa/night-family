# Protocol changelog

Versioning rules and the meaning of major/minor/patch are documented in
[../README.md#protocol-versioning](../README.md#protocol-versioning) and the
discipline for choosing a level when changing the protocol is in
[../AGENTS.md](../AGENTS.md#protocol-changes). The current value lives in
[../shared/src/protocol.ts](../shared/src/protocol.ts).

This file records what changed in each version. Add an entry whenever
`PROTOCOL_VERSION` is bumped. Newest first.

## 1.1.0

Added `firstConnectedAt` to the `MemberSnapshot` payload pushed over `/ws/ui`
(earliest known connection for a member_id, scanned across all token usage
logs). Old UI clients ignore the field; old Households simply omit it.
Member↔Household wire messages unchanged.

## 1.0.0

Initial semver-tracked release. Switched `protocol_version` from a single
integer to a `"major.minor.patch"` string, added compatibility checks
(`compareProtocolVersions`), and started warning on minor skew instead of
rejecting outright. Household now also reports its own `protocol_version`
back to Member in `handshake.ack`. Both sides validate every incoming
WebSocket message against a runtime schema (`parseMemberToHousehold` /
`parseHouseholdToMember`); messages that fail validation are dropped with a
log entry, which is the runtime implementation of the "ignore unknown
messages" half of the minor-bump compatibility rule.
