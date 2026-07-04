# 2. Single-host, single-SQLite control plane

## Status

Accepted.

## Context

keeper coordinates agents running on one developer's machine. The event log and
its projections need durable, transactional storage with strong ordering
guarantees. The obvious "scalable" reflex is a client-server database or a
distributed queue, which would let the control plane span hosts but drags in a
server process to run, network failure modes, connection pools, and operational
weight that a single-machine agent fleet never needs.

## Decision

The control plane is single-host and backed by one embedded SQLite database. The
daemon is the process of record; workers open their own read-only connections and
never share the daemon's handle or write the database directly. Ordering and
atomicity ride SQLite transactions — a cursor and its projection advance together
in one `BEGIN IMMEDIATE` — rather than a distributed consensus layer.

Because the store is embedded, keeper polls `PRAGMA data_version` on a read-only
connection to detect changes: kernel file watchers drop same-process and
write-ahead-log writes on macOS and cannot be trusted against keeper's own
database.

## Consequences

- No database server to install, supervise, or secure; the daemon plus one file
  is the whole control plane, and a backup is a file copy.
- Strong single-writer ordering comes for free, which the event-sourcing model
  leans on heavily; there is no cross-host write contention to reason about.
- The ceiling is one host: this design deliberately does not scale horizontally,
  which is the right trade for a personal agent fleet and the wrong one for a
  multi-tenant service.
- Change detection is a poll, not a watch, on keeper's own database; watchers
  remain available only for external trees and descriptors.
