# 0073 — Sandboxed real-daemon smoke tier

Status: Accepted (provisional number; renumber at fan-in)

## Context

The test doctrine keeps correctness tests deterministic and in-process: no real
daemon, Worker, UDS socket, subprocess, git, or tmux. That buys fast, flake-free
gates — and carries a structural blind spot: a defect living in the contract
between components is invisible to fixtures, because the fixtures are written
from the same misunderstanding as the code. The restart-verdict defect survived
five fixture-green fix generations because the probe demanded a boot header the
serve protocol deliberately omits on memoized steady-state replies; only a live
wire-probe exposed it. The operational history repeats the class: descriptor
staleness zombie cascades, bus accept-stall crash loops, LaunchAgent PATH
paging failures, boot-seed budget exhaustion — all live-only, all found by
operators in production. A slow tier precedent already exists: the real-git
publication suite runs behind its own opt-in gate, outside the correctness
gates.

## Decision

- **One real-daemon smoke executable joins the slow tier.** It boots an actual
  keeperd subprocess with every state class sandboxed under a per-test tmpdir
  (the `sandboxEnv` classes: DB, sockets, ledgers, spools, config) — never the
  host daemon, never host-wide state or locks.
- **The parent owns a hard wall-clock deadline** and kills the entire
  subprocess tree on expiry; a hang is a bounded red result, never a wedge. One
  disclosed retry absorbs environment noise; a second failure is red.
- **The scenario set is enumerated and closed.** Version one: (a) boot →
  catch-up → the served frame/probe contract, including the steady-state
  memo-line shape; (b) kill one real worker and prove main's fatal path,
  bounded teardown, lock and socket cleanup, and the restart-ledger row; (c)
  the restart CLI's evidence verdict end-to-end against the sandboxed daemon,
  with only the launchctl seam injected. **Adding a scenario requires amending
  this ADR** — the exception does not grow by drift.
- **Placement.** The smoke runs behind its own named slow gate, required at
  epic close-finalize for epics whose diff touches the daemon Load surface (as
  declared by the roots manifest), and available to any worker as an opt-in
  named gate. It never joins the correctness gates or the per-task fast loop;
  fast tests stay pure and in-process.

## Consequences

CLAUDE.md's test-isolation rule gains the carve-out sentence naming the slow
tier's two sanctioned real-process members; docs/testing.md documents the gate.
The finalize suite selection learns the load-surface conditional. Contract
drift between serve frames and their consumers is now caught at finalize
rather than by operators; the cost is one bounded slow run per daemon-surface
epic.
