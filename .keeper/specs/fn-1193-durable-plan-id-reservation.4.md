## Description

**Size:** M
**Files:** plugins/plan/src/id_ledger.ts, plugins/plan/src/ids.ts, plugins/plan/src/verbs/scaffold.ts, plugins/plan/src/verbs/epic_create.ts, plugins/plan/src/verbs/refine_apply.ts, plugins/plan/test/src-id-ledger.test.ts, CLAUDE.md

### Approach

Make number reservation durable against working-tree destruction. New pure module
id_ledger.ts (node:fs only — no git, no bun:sqlite, no facade): an append-only
JSONL file per project under `~/.local/state/keeper/id-ledger/<realpath-hash>.jsonl`
(sha256 of the primary_repo realpath, the audit_artifacts idiom), each record one
bounded single-write() JSON line `{kind:"epic"|"task", epic_num, epic_of?, task_num?,
id, ts}` — newline-injection-safe since slugs are minter-influenced. Reading
tolerates a corrupt trailing record (crash-truncated tail is ignored; degrade to
scan). Allocation at the three mint sites becomes max(scan, ledgerMax)+1 with the
append inside the existing epic-id flock, before any file write: epic numbers in
scaffold and epic-create, task numbers (per-epic scope) in refine-apply. Every
ledger IO failure is fail-soft to scan-only — never break a mint. Deleting an epic
(`epic rm`) must NOT lower the ledger; a deleted number stays burned. Add the
mint-time same-project bare-number guard in the same flock section: if any existing
epic file in this project carries the candidate number under a different slug,
refuse with the existing `id_collision` code naming both ids (reuse the code, don't
mint a parallel one). Finish with the two CLAUDE.md one-liners if the size gate
allows: allocation is max(scan, ledger)+1 never bare scan; the plan CLI is the id
ledger's sole writer, folded into the existing Sole-writer rules bullet
(`bun scripts/lint-claude-md.ts` must stay green).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/ids.ts:107,131 — scanMaxEpicId (scans epics/ AND specs/ — preserve the orphan-spec invariant) and scanMaxTaskId
- plugins/plan/src/verbs/scaffold.ts:1004-1088 — the flock critical section (scan → dup guards → allocate → write) where the ledger consult+append and the bare-number guard land; FlockOutcome sentinel (never emit inside the lock)
- plugins/plan/src/verbs/refine_apply.ts:491-496 — task-number allocation under the same flock; the ledger's per-epic task entries land here
- plugins/plan/src/audit_artifacts.ts:241,287 — the sha256 + realpathSync keying idiom to copy
- plugins/plan/src/flock.ts:138-182 — withEpicIdLock's fail-soft: the ledger inherits an UNLOCKED degrade when the state dir is unwritable, so ledger reads must never assume exclusivity

**Optional** (reference as needed):
- plugins/plan/src/verbs/epic_create.ts:73-106 — the second epic-number mint site and its existing exact-filename dup guard
- docs/problem-codes.md — the id_collision row this guard reuses
- scripts/lint-claude-md.ts — the size gate for the CLAUDE.md lines

### Risks

- Under an unlocked (environmental-degrade) flock the ledger adds no mutual exclusion — two unlocked processes can still race the scan; accepted, since its purpose is surviving file destruction, and the loud-detection layer is the net for the degraded case
- The ledger must key on the STATE repo (primary_repo) realpath even when the verb runs from a lane worktree, or a lane mint forks a second ledger
- Ledger growth is unbounded by design (one line per mint); tail-read last-valid-wins keeps reads O(1)-ish if it ever matters — do not add compaction machinery now

### Test notes

Pure node:fs unit tests, zero git: fresh project (no ledger) allocates scan+1 and
creates the file; delete-the-files-keep-the-ledger allocates N+1 (the incident
regression test); corrupt trailing line degrades to scan; unwritable ledger dir
falls back to scan-only without failing the mint; task numbers key per-epic; the
bare-number guard refuses a same-number/different-slug sibling with id_collision
naming both ids.

## Acceptance

- [ ] With a populated ledger, deleting every file of a minted epic and re-minting yields a strictly higher number — the incident sequence cannot reuse fn-N on the same host
- [ ] Task-number allocation through refine-apply consults and appends the same ledger, scoped per epic
- [ ] Any ledger IO failure (missing dir, unwritable file, corrupt tail) degrades allocation to scan-only and never fails the verb
- [ ] Minting a number that an existing same-project epic already carries under a different slug is refused with `id_collision` naming both full ids
- [ ] CLAUDE.md carries the allocation and sole-writer guardrails within the lint size gate, or the epic's Docs gaps note records why they did not fit

## Done summary
Added a durable host-local id ledger (id_ledger.ts) consulted at all three mint sites so allocation is max(scan, ledger)+1 — destroying a minted epic's/task's files can no longer free its number. Added a same-project bare-number guard reusing id_collision; every ledger IO failure fails soft to scan-only.
## Evidence
