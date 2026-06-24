## Overview

A directed `keeper bus chat send` can bind the WRONG sender identity: the relay
resolves a connecting peer's identity from keeper.db `jobs` by pid ALONE, so an
OS-recycled pid that still carries a lingering dead `jobs` row gets attributed to
the dead agent. Confirmed live: `sitter-system-overview` (pid 39312) sent 4
health-checks to its triage agents; the 4th's short-lived send subprocess inherited
pid 89510 — a pid that belonged to dead agent `fix-duplicate-approve-bug` on Jun
7–8 whose `jobs` row still read `pid=89510` — so the recipient saw the wrong sender,
"replied" to that offline phantom, and broadcast the reply to the whole fleet. End
state: bus identity enrichment matches `(pid, start_time)` (mirroring the guard the
rest of the bus identity code already uses), and agent skills never fall back to
broadcast on a missed directed send.

## Quick commands

- `bun run test:full` — the recycled-pid regression test (pure, injected probe) is green
- `keeper bus chat send <peer> "hi"` from one agent while another agent's old pid is recycled — recipient sees the real sender, never a stale/dead identity

## Acceptance

- [ ] A directed send whose subprocess holds an OS-recycled pid with a lingering dead `jobs` row is attributed to the TRUE sending agent (or honestly unknown), never the dead agent.
- [ ] Bus identity enrichment keys on `(pid, start_time)`, consistent with `src/bus-identity.ts` and the recycled-pid guard in `src/exit-watcher.ts`.
- [ ] Agents/workers never convert a missed/offline directed send into a fleet broadcast.

## Early proof point

Task that proves the approach: `.1` — FIRST confirm `jobs.start_time` (written by the
events-writer hook) and `readOsStartTime` emit the byte-identical platform-tagged
string (they share `splitArgsLstart`/`parseLinuxStarttime`). If they differ, the
verbatim-compare premise is false and the guard must normalize formats before
matching — reconcile that before writing the WHERE clause.

## References

- Incident: sitter-system-overview's 4-send burst (msgs 1559–1562); the 4th bound to dead `fix-duplicate-approve-bug` (pid 89510), events show 89510 = that session's Jun-7/8 pid.
- Sibling guards already in-repo: `src/bus-identity.ts:110` `liveChannelForIdentity` matches `(pid, start_time)`; `src/exit-watcher.ts:266` `selectDeadReprobeCandidates` is the recycled-pid model.
- Unrelated sibling epic `harden-keeper-against-host-starvation` (daemon resilience) — no shared files.

## Best practices

- **`(pid, start_time)` is the canonical OS-pid-reuse identity:** a bare-pid match proves only that *some* process has that number, not that it's the one that registered.
- **Read start_time once per matched row, never per message / per hop:** a `ps` spawn per ancestry hop reintroduces the host-starvation cost class.
- **Fail closed on an unreadable probe:** when start_time can't be confirmed, drop the enrichment and climb — never bind an unverified pid-only identity.

## Docs gaps

- **README.md** (bus anti-spoof sentence, ~:3137): fold `(pid, start_time)` verification into the existing OVERWRITES sentence — handled in `.1`.
- **CLAUDE.md** (the "pure send is EPHEMERAL" bus block): note the recycled-pid guard applies to BOTH the deregister path and the enrich path — handled in `.1`.
- **plugins/keeper/skills/bus/SKILL.md** + **plugins/plan/template/skills/work.md.tmpl**: anti-spoof wording + broadcast-fallback prohibition — handled in `.2`.
