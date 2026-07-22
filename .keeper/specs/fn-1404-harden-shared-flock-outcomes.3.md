## Description

**Size:** M
**Files:** src/file-lock.ts, src/usage-flock.ts, src/account-observation-refresh.ts, src/account-router.ts, src/bus-artifact.ts, src/codex-account-observation-refresh.ts, src/codex-account-router.ts, src/codex-pool-activation.ts, src/history/index-db.ts, src/note-backup.ts, src/note-store.ts, src/pair/panel.ts, src/restore-verify.ts, plugins/prompt/src/claude_worker_compiler.ts, plugins/prompt/src/prompt_compiler.ts, test/usage-flock.test.ts, test/account-observation-refresh.test.ts, test/account-router.test.ts, test/bus-artifact.test.ts, test/codex-account-observation-refresh.test.ts, test/codex-account-router.test.ts, test/codex-pool-activation.test.ts, test/history-index.test.ts, test/note-backup.test.ts, test/note-store.test.ts, test/restore-verify.test.ts, plugins/prompt/test/claude_worker_compiler.test.ts, plugins/prompt/test/render_plugin_templates.test.ts

### Approach

Migrate every general `FileLock` consumer from ambiguous lock-or-null/throw behavior to an explicit policy over Acquired, Contended, and Inconclusive, then remove transitional nullable APIs. Mutation-critical stores and compilers refuse Inconclusive before writing; optional observations and refreshes may skip or use their established visible fallback; admission-style paths keep contention distinct from broken lock infrastructure. No caller may map Inconclusive to “busy” solely for convenience or execute its protected write without a held handle.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/file-lock.ts:193` — general blocking/nonblocking public API.
- `src/usage-flock.ts:193` — duplicate API used by daemon, Notes, restore, and panel surfaces.
- `src/account-router.ts:455` — mutation-critical account-ledger lock use.
- `src/bus-artifact.ts:480` — nonblocking Bus artifact lock policy.
- `src/history/index-db.ts:254` — History-index lock acquisition.
- `src/pair/panel.ts:2707` — panel admission lock seam.
- `plugins/prompt/src/claude_worker_compiler.ts:27` — prompt-package general lock consumer.

**Optional** (reference as needed):
- `src/note-store.ts:317` — blocking Note-store mutation.
- `src/restore-verify.ts:810` — restore apply lock acquisition contract.
- `src/codex-pool-activation.ts:448` — activation lock policy.

### Risks

These callers intentionally fail in different directions; a blanket mapping would either reduce availability unnecessarily or permit an unsafe write. Consolidating duplicated wrappers must not introduce a database import into agent cold-start paths, and removing compatibility APIs must wait until import search proves no consumer remains.

### Test notes

Add or extend caller-level injected tests for each policy class: integrity mutation refuses Inconclusive, optional observation skips/falls back visibly, positive contention keeps its existing busy/defer behavior, and Acquired performs exactly one protected operation followed by release. Finish with import/type searches proving no nullable/throw-only acquisition contract remains.

### Detailed phases

1. Classify callers by integrity mutation, admission, or optional refresh/observation policy.
2. Migrate each family to exhaustive tagged-outcome handling with focused tests.
3. Remove duplicate/transitional APIs and prove all imports use the canonical root contract.

### Alternatives

Keeping compatibility wrappers indefinitely is rejected because future callers could silently reintroduce the ambiguity. Treating every caller as mutation-critical is safe but unnecessarily wedges optional observations; caller-specific fail direction remains explicit.

### Non-functional targets

Preserve cold-start import boundaries and existing successful-path latency. Every defer/fallback is bounded and observable through the caller's existing diagnostics; no global lock, fixed sleep, host state, or lock-file unlink is introduced.

### Rollout

Migrate caller families in small compilable groups within the task, retaining exhaustive switches and focused tests before removing transitional exports at the end.

## Acceptance

- [ ] Every root `FileLock` consumer handles Acquired, Contended, and Inconclusive explicitly at its policy boundary.
- [ ] Mutation-critical stores, activation, restoration, and compilation perform no protected write after Inconclusive.
- [ ] Optional refresh and observation paths retain their intended availability through an explicit defer or visible fallback that never impersonates positive contention.
- [ ] Positive contention retains existing busy/defer semantics without being conflated with lock infrastructure failure.
- [ ] No transitional nullable or throw-only general acquisition API remains reachable by repository consumers.

## Done summary

## Evidence
