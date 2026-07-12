# 50. Wrapped-cell total-edit-denial guard and dumb-courier wrapper contract

## Status

Accepted (number PROVISIONAL until landed; fan-in renumber per ADR 0020). Builds on
[ADR 0010](0010-host-provider-matrix-and-wrapped-worker-cells.md) (the wrapped-cell
architecture) and [ADR 0047](0047-provider-equivalence-map-and-worker-provider-pin.md)
(the worker-provider dispatch pin this guard deliberately does NOT key on). Reuses the
`PreToolUse` guard precedent [ADR 0025](0025-wrong-tree-write-guard.md) (marker-keyed
jurisdiction) and its escalation-guard-derived fail-closed-when-marked posture.

## Context

The wrapped-worker contract that delegates implementation to a foreign provider leg has
always been prompt-only: nothing mechanically stopped a wrapped `work:worker` from
reaching for Edit/Write/Bash and implementing natively instead of delegating. A wave of
wrapped-cell runs showed the failure mode is real — several gpt-cell workers carried the
correct wrapped system prompt yet implemented natively with sonnet anyway. With
`worker_provider` pinnable to codex (ADR 0047), every future wrapped-cell dispatch
depends on this contract holding, so a prompt-only guard is no longer acceptable.

A mechanical guard needs a reliable, forgeable-proof signal that THIS session is a
wrapped cell's worker, deniable before any edit lands, and a wrapper tool surface narrow
enough that denying source-editing tools doesn't also break launch/wait/adjudicate/
close-out. The second did not hold under the prior contract, which had the wrapper
hand-fix lint and test failures itself after the leg's implementation pass — denying
Edit/Write there would have broken every run needing even one lint fix.

## Decision

**A launch-injected marker carries wrapped-cell identity.** The exec boundary
(`buildKeeperAgentLaunchArgv`) always emits `KEEPER_WRAPPED_CELL`/`KEEPER_WRAPPED_ENVELOPE`
on every `work` launch — empty for a native effective cell, the effective
`<model>::<effort>` plus the provider-leg result-envelope path for a wrapped one.
Always-emit matters because a reused tmux session must never inherit a stale marker. The
marker is keyed on effective-cell wrappedness — never the `worker_provider` pin (ADR
0047): a pin translates which cell dispatches, jurisdiction here is about what the
launched worker IS. Both work-launch producers (autopilot, manual `keeper dispatch`)
inject it through the same shared seam.

**`wrapped-guard`, an eighth `PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash)` hook,
is a single-state total edit-denial — no envelope gate, nothing forgeable.** It need not
distinguish "the leg isn't done" from "unlock now": under the dumb-courier contract
below the wrapper NEVER authors source at any point, so denial holds for the whole
session. Jurisdiction is two conditions, both required: the marker is non-empty, AND the
tool payload carries `agent_id`/`agent_type` (the wrapped subagent, not the wrapper's own
orchestrator turn). A marked subagent gets Edit/MultiEdit/NotebookEdit denied outright,
an in-tree Write denied (outside every tracked tree stays allowed), and every Bash
command must clear a POSITIVE allowlist covering only delegation and close-out (`keeper
agent`/`commit-work`/`plan`/`session`/`baseline`, read-only + staging git, the test
runner) — the whole shell-operator/redirect/heredoc/substitution surface and every
re-entrant wrapper are rejected before classifying a command at all, a blocklist having
been rejected outright given Claude Code's own regex blocklist fell to documented
bypasses. A marked session fails CLOSED on anything it cannot positively clear; an
unmarked one is inert. Every path exits 0.

**The wrapper contract is rewritten as a dumb courier so the guard never has anything
legitimate to deny.** It no longer hand-fixes a red test, a lint failure, or a gap the
leg left — every one goes back to the SAME leg via `keeper agent run --resume`, driven
across turns until the leg reports done. Its tool surface shrinks to exactly what the
guard allows: launch (a native `keeper agent run` detach, replacing the earlier
hand-rolled `nohup`/pidfile launch the re-entrant-wrapper denial would have blocked
anyway), wait, read the provider-leg result envelope, re-run tests, and the keeper
close-out — a compliant wrapper never needs an edit tool, so denying all of them costs
it nothing.

## Consequences

- A wrapped worker reaching for Edit/Write/an off-allowlist Bash command is mechanically
  stopped before the edit lands, independent of system-prompt drift.
- The guard is only as good as the marker's integrity: a launch path bypassing
  `buildKeeperAgentLaunchArgv` entirely would escape jurisdiction — both current
  work-launch producers ride the shared seam; a future one must too.
- The wrapper cannot self-recover from a stuck leg by editing around it — every
  iteration runs back through the leg, bounded by the same two-full-suite-run cap and
  `stop_timeout_ms`/`max_attempts` budget as launch; a leg that will not converge still
  ends in `BLOCKED`, exactly as a native worker's own unrecoverable red suite does.
- The guard is single-state, needing no coordination with the provider-leg envelope's
  `outcome` — marker-gated denial and envelope-carried leg result are independent.
