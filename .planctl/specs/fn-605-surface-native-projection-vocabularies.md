## Overview

The keeper projection laundered two pieces of state into shapes that lied about what the event log knew: task `status` was a derived binary (`open|done`) over the `worker_done_at` timestamp, and `subagent_invocations.status` declared a 4-value enum but the reducer only ever wrote 2 of them. The renderer (`scripts/board.ts`) then collapsed the subagent values further to `[running]/[stopped]` and derived a `is_replaced` flag client-side to hide superseded same-type subs. This epic surfaces the native vocabularies end-to-end: planctl's runtime task enum (`todo|in_progress|done|blocked`) ingested from `.planctl/state/tasks/`, the existing derived field renamed to `worker_phase`, the subagent enum widened to 5 values with three new reducer write paths (`failed` / `unknown` / `superseded`), and the board renderer simplified to stamp the raw values without compression or hiding. The new Design stance in `CLAUDE.md` authorizes the schema bumps and client-touching changes.

## Quick commands

- `bun test test/plan-worker.test.ts test/reducer.test.ts test/subagent-invocations.test.ts` — full new-arm + parity coverage
- `bun scripts/board.ts` — visual check; task rows show `[runtime_status] [worker_phase] [approval]`; subagent rows show raw `[running|ok|failed|unknown|superseded]`

## Acceptance

- [ ] `runtime_status` on every embedded task element matches the live `.planctl/state/tasks/<task_id>.state.json` `status` field (defaulting to `todo` when absent), confirmed against this repo and one other planctl-managed repo
- [ ] Re-fold from cursor 0 produces byte-identical `epics.tasks` JSON for at least one snapshot of the live DB (re-fold determinism)
- [ ] `subagent_invocations` rows show `failed` / `unknown` / `superseded` values after the appropriate event sequences (golden fixtures cover all three)
- [ ] `scripts/board.ts` renders both task pills side-by-side and stamps raw subagent statuses — no `[stopped]` collapse, no `is_replaced` filter, no `[superseded]` hiding
- [ ] `seedFromDb`'s reconstruction reproduces `buildTaskMessage`'s output byte-for-byte (no spurious re-emits on daemon restart)

## Early proof point

Task that proves the approach: task `.1` (runtime_status ingest + worker_phase rename + seedFromDb parity). If the parity test passes — i.e. `buildTaskMessage` and `seedFromDb` produce byte-identical JSON for every persisted task across a boot — the rest of the epic is mechanical. If it fails: revisit whether the projection should ingest `.planctl/state/` at all or whether keeper should remain blind to that subtree.

## References

- `CLAUDE.md` `## Design stance` (lines 11–29) — authorizes the schema bumps and client-touching changes
- `CLAUDE.md` `## Event-sourcing invariants` — re-fold determinism rules
- `src/db.ts:862-873` v10→v11 — template for rewind-and-redrain re-derivation
- `src/plan-worker.ts:841-949` `seedFromDb` — change-gate parity, the #1 silent regression risk
- `src/reducer.ts:528-531` — embedded `jobs` sub-array carve-out pattern (mirror for new task fields)
- `/Users/mike/code/arthack/apps/planctl/planctl/store.py:151` — on-disk shape of `.planctl/state/tasks/*.state.json`

## Docs gaps

- **`README.md` lines 67-70**: subagent_invocations vocabulary update (`running|ok|failed|unknown|superseded`)
- **`README.md` lines 258-284**: board.ts client description — drop `is_replaced` mention, drop `[running]/[stopped]` collapse description
- **`README.md` lines 440-442**: inspect snippet vocabulary update; consider adding `worker_phase` + `runtime_status` columns to the tasks inspect snippet
- **`CLAUDE.md` plan-worker invariant block**: one-sentence splice naming `.planctl/state/tasks/` as a second watched subtree feeding TaskSnapshot

## Best practices

- **Don't subscribe to `.planctl/state/tasks/` separately** — the existing recursive `@parcel/watcher` on the repo root already sees it; extend `classifyPlanPath` to the 4-segment shape instead.
- **Keep `unknown` in the terminal-status guard alongside `failed` and the new `superseded`** — otherwise a late SubagentStop after a session-terminal sweep would flip `unknown` → `ok`. The guard already protects `failed`/`unknown` at `reducer.ts:876,948`; just add `superseded`.
- **No CHECK constraint on `subagent_invocations.status`** — widening is clean (TS type + write path). Adding a CHECK constraint now would require the 12-step SQLite recreate-table procedure; not worth it.
- **`seedFromDb` reconstruction must add new fields in identical slot order** as `buildTaskMessage` — `JSON.stringify` byte-compare is the change-gate, and slot mismatch re-emits a synthetic event every daemon boot per task. Repo-scout flagged this as the #1 silent regression risk.
- **State files are gitignored** — fresh clones default `runtime_status` to `todo`; this is correct behavior, no special-case needed.
