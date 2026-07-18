## Overview

Four bounded, file-disjoint cleanups with live-or-stale evidence: reproduce and fix
how absent-lane `worktree-lane-backup-failed` distress rows escaped their clear
arms; harden every agentbot notifier spawn against the LaunchAgent's minimal PATH
through one shared helper; migrate the deliberate NUL composite-key separators to a
shared named constant and widen the lint gate source-wide (net-new-NUL ban +
comments-only fn-id/provenance rule with a frozen shrink-only allowlist); and make
`keeper plan epics` output self-identify its resolved project so a foreign-cwd
listing can never be mistaken for another board.

## Quick commands

- bun test ./test/autopilot-worker.test.ts && bun test ./test/lint-claude-md.test.ts && bun test ./test/status.test.ts
- bun run typecheck && bun run lint

## Acceptance

- [ ] A deterministic red repro pins why an absent lane's backup-failed distress row escaped its clear arm, and the fixed producer clears it while never over-clearing a present-but-unenumerable lane
- [ ] Every agentbot page site spawns through one shared helper with a configured absolute path, existence probe, and log-once degrade
- [ ] Raw NUL literals are banned net-new with the six separator sites migrated to one shared constant, and the fn-id/provenance comment rule runs source-wide behind a frozen shrink-only allowlist
- [ ] `keeper plan epics` names the project it resolved in both JSON and human output

## Early proof point

Task ordinal 1 (the lane clear-arm red repro) proves the investigation approach: a
failing in-process test reproducing the escape under the injected normalize seam.
If neither candidate cause reproduces: record the null result with evidence and
downgrade the fix task to a defensive normalization pin plus the enumeration-gate
log line.

## References

- src/autopilot-worker.ts:2077,2114,9026-9032 — lane-backup distress mint/route; clear gated on laneEnumerationComplete (:8045); finishCycle early-return (:2147)
- src/autopilot-worker.ts:576 — normalizeLanePath realpathSync.native: resolves when present, falls back raw when absent (the asymmetry hypothesis)
- src/integrity-probe.ts:203-256 — sendAgentbotPage + outcome classifier; daemon.ts:1556,1582,1608,2917,3115,12796 + maintenance-worker sink — the ~8 spawn sites
- scripts/lint-claude-md.ts:44-61 CONTENT_PATTERNS; scripts/lint-retired-name.ts walker/exclusion idiom
- plugins/plan/src/project.ts:76-83 cwd-only resolveProject; plugins/plan/src/verbs/epics.ts:53-90 runEpics
- Epic deps: none — the status-taxonomy sibling epic owns the fn-1326-colliding surface

## Docs gaps

- **docs/problem-codes.md**: add the missing `lane-backup-failed` row (meaning, producer clear condition, retry-safety) and make the Operator paging section's transport naming consistent
- **CLAUDE.md**: two-line rule-#0 touch stating the lint gate now spans source (no-fn-id comments + no-NUL), pruned not grown
- **docs/adr/0053**: amendment note only if clear-arm semantics actually change (a pinned normalization bug alone does not amend)

## Best practices

- **Never rely on PATH under launchd:** configured absolute notifier path + existence probe; test the degrade under `env -i` with the stripped launchd PATH
- **Log-once latch:** a persistently absent notifier logs one line, mirroring the paged-once distress discipline — never one line per sweep
- **Comments-only lint matching with false-positive fixtures:** "fn-123" in a string literal and a SHA-256 hex must not trip the rule; grandfather existing hits into a shrink-only allowlist
- **Escape-don't-strip at emission sinks** if any NUL-separated key proves leak-reachable; internal-only keys migrate to the shared constant instead
