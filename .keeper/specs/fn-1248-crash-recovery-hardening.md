## Overview

Seven reliability bugs surfaced during a crash recovery, unified by one theme:
keeper trusts point-in-time or identity-less liveness signals that a reboot
invalidates. The load-bearing cluster is tab-restore liveness identity — the
`isLive` gate, the point-in-time restore verify, and the `keeper tabs list`
current-set all trust stale evidence and mask processes that died. The
remainder are daemon hygiene: a resume-command that emits a fake CLI flag,
a panel-dir GC that never runs, boot log spam, and backup churn. Every claim
here is secondhand and UNVERIFIED, so each task reproduces the bug before
designing a fix.

## Quick commands

- `bun test tabs restore-set restore-verify resume-descriptor pair-panel backup compaction`  # the relevant fast suites
- `keeper tabs list --json`  # current-set snapshot (item 3 surface)
- `keeper agent panel prune`  # manual panel GC (item 5 — should become automatic)

## Acceptance

- [ ] Tab restore no longer treats a past attach/verify as current liveness — a process that dies after verification is re-observed as dead, not masked.
- [ ] `keeper tabs list` current-set is keyed on recycle-safe `(pid, start_time)` identity, so a reboot-recycled pid does not surface a phantom session.
- [ ] The human-pasted resume command runs in an alias-less shell (no fake `--x-no-confirm` flag reaching the real claude binary).
- [ ] Panel dirs are reaped automatically without a human running the verb.
- [ ] Boot log volume from the merge-gate/reconcile path is bounded (the ~39k-lines/boot emitter is identified and coalesced or demoted).
- [ ] Daily backup I/O churn is reduced without weakening restore safety.

## Early proof point

Task that proves the approach: task `.1` (tabs restore liveness). If reproduction
shows the intent record carries no `(pid, start_time)` handle to probe against,
the fix's first move is persisting that handle — surface it before designing the gate.

## References

- `(pid, start_time)` recycle identity is a solved in-repo pattern — reuse `src/proc-starttime.ts`, `src/seed-sweep.ts:99` (`readOsStartTime`), `src/exec-backend.ts:485` (`parseGenerationId`); thread it through an INJECTED seam (precedent: `src/exit-watcher.ts:403`, `src/agent/resume-policy.ts:185`, `src/bus-worker.ts:782`) — never call `readOsStartTime` directly (fast tests forbid subprocesses). Do not add a 6th `pidAlive` variant.
- CONTEXT.md already defines liveness as pid+start-time identity — this epic brings code into conformance with the glossary, not a new term.
- Overlap (advisory, not a hard dep): `fn-1239-replace-usage-with-account-routing` also edits the resume/restore launch seam; keep the item-4 change display-scoped so the worktree fan-in merge stays clean.
- DB file-size reclamation (the 1.9 GB → offline VACUUM INTO + mv) is handled as a separate operator maintenance window, NOT in this epic. Task `.6` covers only backup-churn reduction; it must not touch the immutable `events` table or add a `SCHEMA_STEPS` entry.

## Docs gaps

- **docs/problem-codes.md**: revise the Tabs-family exit-8 row in place if items 1-3 change the recycled-pid dedup story (new row only if a genuinely new code is emitted).
- **docs/install.md** / **README.md**: revise the Backup & restore prose only if task .6 changes backup cadence; keep the code-rendered runbook as source of truth.

## Best practices

- **Key process identity on `(pid, start_time)`, never bare pid:** the PID space is small and reused, doubly so after reboot. A stored identity whose start-time mismatches is a different process — treat as dead.
- **Replace point-in-time liveness with a dwell/startup-window check:** require a process to stay healthy for a minimum dwell before declaring it up; a single check passing just before a death is the TOCTOU failure this bug class is made of.
- **Log-spam mitigation:** coalesce per-key (log first + a periodic "N suppressed" summary) and demote steady-state boot chatter below the default level.
