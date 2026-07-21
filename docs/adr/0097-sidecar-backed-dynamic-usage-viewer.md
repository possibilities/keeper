# 97. Sidecar-backed dynamic account usage viewer

## Status

Accepted. Extends ADR 0090's sanitized Codex capacity boundary and ADR 0092's Claude
Capacity observation. The account-profile usage Projection, terminal scraper, and frames
route remain retired.

## Context

Keeper publishes private, atomic Capacity observations for managed Claude and Codex
accounts. They already carry routing evidence, but operators need one human view as quota
windows appear, disappear, and reorder. Bounded provider account category and explicit
capacity class also explain why nominally similar accounts may have different allowances.

Claude observations carry dynamic window keys. Codex formerly discarded base-window
durations and bounded `limit_name` values. Whole provider objects cannot cross ADR 0090's
credential and PII boundary, while restoring the scraper and Projection would duplicate the
observations routing already trusts.

## Decision

`keeper usage` is a read-only, daemon-independent viewer over normalized Capacity
sidecars. It polls their stable paths after atomic replacement; it never watches an inode,
invokes an observer, reads credentials, or stores provider payloads.

Each meter array is a full snapshot. Claude keeps its window key; every Codex window adds a
stable key and display label, optional bounded duration, utilization, and reset instant.

Provider account metadata is independently optional and display-only. Claude-swap admits
`subscriptionType` only as `pro` or `max` and maps exact known `rateLimitTier` values to
multipliers `1`, `5`, or `20`. When usage is no longer decision-trusted, its JSON keeps
`usageStatus: unavailable` and `usage: null` while carrying separately aged last-good meters;
Keeper preserves those as display-only account measurements without making a route eligible.
The Codex companion maps known classes only to `free`, `go`, `plus`, `pro`, `pro-lite`,
`business`, `enterprise`, or `edu`; it exposes no inferred multiplier. Invalid or unavailable
metadata is omitted without invalidating meters, and the viewer never infers a value.

A Codex `limit_name` in the bounded public GPT/Codex/OpenAI namespace may label a meter.
Account-, token-, plan-, identity-, and suspicious-number-shaped names fail classification.
Unnamed base labels derive from `limit_window_seconds`; invalid names degrade to ordinal
additional-meter labels. Raw plan names, OAuth material, headers, and arbitrary sibling
fields never cross the boundary; canonical account category is the sole plan-adjacent value.

The viewer polls once per second. Meter, value, and status changes emit history; heartbeat,
reset, and countdown movement repaint locally without forging frames. Missing, invalid,
stale, unavailable, exhausted, and auth states remain explicit. An unavailable Claude row
with last-good data renders its aged meters under `[unavailable]`; other account failures keep
fixed PII-free reasons. Headers append metadata such as `Claude 1 · Max 20×`, with no
placeholder for unknown fields. Non-TTY output emits one snapshot through the shared view shell.

The viewer does not join `keeper frames`: sidecars lack a daemon Fold cursor and reconnect
coverage claim, so inclusion would misrepresent provenance.

## Alternatives considered

- **Restore the Projection and scraper.** Provider terminal output is not a stable protocol.
- **Render fixed columns.** Providers add and remove meters independently.
- **Show only `additional N`.** This hides bounded public meter names.
- **Persist raw limit entries or plan strings.** They exceed the sanitized contract.
- **Infer a Codex multiplier.** Category and quota windows are not authoritative numeric classes.
- **Use filesystem notifications.** Stable-path polling remains correct across replacement.

## Consequences

- One command shows cross-provider capacity without reducer, migration, RPC, or credential writes.
- Sanitized observation changes, not viewer releases, add or remove meters.
- Category and multiplier metadata is additive; unknown producer values vanish at sanitization.
- A stopped daemon leaves inspectable sidecars whose age renders honestly.
- Frame consumers remain daemon-derived; usage uses viewer snapshots instead.
