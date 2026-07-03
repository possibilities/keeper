## Description

**Size:** S
**Files:** cli/setup-tmux.ts, scripts/restore-agents.ts, test/setup-tmux.test.ts

### Approach

Make the setup-tmux restore offer trustworthy: the offer count and the
applied restore route through the same selection seam. The offer computes
per-session counts in-process from the new deriver (read-only, no tmux
drive) and the prompt carries generation context — age and agent count —
so a skeleton is recognizable at the prompt. On confirm, spawn `keeper
tabs restore --apply --session <name> --generation <chosen>`
SYNCHRONOUSLY through the existing SyncSpawnFn seam (ExecBackend stays
subprocess-owned), capture exit code and output, and print one
authoritative outcome line per session — success with generation context
or the verbatim failure, including the autopilot-gate refusal. Replace
buildRestoreAgentsArgv with the keeper-tabs argv builder and delete the
scripts/restore-agents.ts shim (its last consumer is gone). The
count/apply race — a candidate going live between count and apply — must
read as a benign zero-restored outcome, not a failure.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/setup-tmux.ts:653-716 — RESTORABLE / CandidateCountFn / defaultCandidateCount / buildRestoreAgentsArgv; :786-827 — the offer + fire-and-forget spawn loop being replaced
- test/setup-tmux.test.ts:468-500 — TTY patch pattern and existing offer tests

**Optional** (reference as needed):
- cli/tabs.ts — restore flag surface (from the dep task)

### Risks

- setup-tmux runs before any daemon guarantee — the count path must stay read-only keeper.db with graceful degradation to a skipped offer, exactly like today's defaultCandidateCount catch.

### Test notes

Offer tests assert: the prompt carries generation age and count; confirm
spawns the tabs argv synchronously; a non-zero child exit surfaces its
stderr and marks the outcome line failed; declined and non-TTY paths
unchanged; no references to the deleted script remain.

## Acceptance

- [ ] The offer prompt and the applied restore derive from the same generation selection, so the promised count matches what apply restores
- [ ] Restore outcomes, including failures and the autopilot-gate refusal, print synchronously with generation context; nothing is fire-and-forget
- [ ] The legacy restore-agents script is retired with no remaining references

## Done summary

## Evidence
