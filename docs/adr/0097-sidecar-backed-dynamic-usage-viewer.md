# 97. Sidecar-backed dynamic account usage viewer

## Status

Accepted. Extends ADR 0090's sanitized Codex capacity boundary and ADR 0092's
Claude Capacity observation. The account-profile usage Projection, terminal
scraper, and frames route remain retired.

## Context

Keeper publishes private, atomic Capacity observations for every managed Claude
and Codex account. They already carry the utilization and reset evidence used
for routing, but operators need a unified human view. Provider quota surfaces
change without notice: base windows disappear, model-specific meters appear,
and their ordering cannot define fixed columns.

Claude observations carry dynamic window keys. The Codex observer retained only
`primary`, `secondary`, or `additional`, discarding base-window durations and
bounded `limit_name` values such as `GPT-5.3-Codex-Spark`. Whole provider objects
cannot cross ADR 0090's credential and PII boundary. Restoring the old scraper
and Projection would also make terminal presentation a machine contract and
duplicate the observations routing already trusts.

## Decision

`keeper usage` is a read-only, daemon-independent viewer over the normalized
Capacity sidecars. It polls their stable paths because producers publish by
atomic replacement; it never watches an inode, invokes an observer, reads
credentials, or stores provider payloads.

Each account's meter array is a full snapshot, so additions and removals appear
on the next poll. Claude uses its existing window key. Every Codex window adds:

- a stable key and display label;
- the bounded provider window duration when present; and
- utilization plus reset instant.

A bounded Codex `limit_name` in the public GPT/Codex/OpenAI namespace labels a
named meter. Account-, token-, plan-, identity-, and suspicious-number-shaped
names fail classification. Unnamed base labels derive from
`limit_window_seconds` (`18000` is `session`, `604800` is `weekly`); unknown
values stay duration-labeled. Invalid names degrade to ordinal additional-meter
labels. Internal feature codes, identity, plan names, OAuth material, headers,
and arbitrary sibling fields never cross the observer boundary.

The live viewer polls once per second. Visible meter, value, and status changes
emit history; heartbeat timestamps, reset targets, and countdown movement
repaint locally without forging frames. Missing, invalid, stale, unavailable,
exhausted, and per-account auth states remain explicit. Non-TTY output emits one
snapshot through the shared view shell.

The viewer does not join `keeper frames`: sidecars have no daemon Fold cursor or
reconnect coverage claim, so inclusion would misrepresent provenance.

## Alternatives considered

- **Restore the Projection and scraper.** Normalized observations own the
  capacity boundary; provider terminal output is not a stable protocol.
- **Render fixed columns.** Providers add and remove meters independently.
- **Show only `additional N`.** Discarding a bounded public meter name hides the
  distinction the viewer exists to expose.
- **Persist raw additional-limit entries.** They can carry internal feature or
  future account metadata outside the sanitized quota contract.
- **Use filesystem notifications.** Stable-path polling remains correct across
  atomic replacement and is faster than producer refresh.

## Consequences

- One command shows cross-provider capacity without widening reducer, migration,
  RPC, or credential surfaces.
- Sanitized observation changes, not viewer releases, add or remove meters.
- Codex metadata is additive; existing role/utilization/reset readers continue.
- A stopped daemon leaves inspectable sidecars whose age renders honestly.
- Frame consumers remain daemon-derived; usage uses viewer snapshots instead.
