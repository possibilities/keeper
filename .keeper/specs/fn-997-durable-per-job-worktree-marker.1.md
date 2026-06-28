## Description

**Size:** M
**Files:** src/types.ts, src/autopilot-worker.ts, src/exec-backend.ts, plugins/keeper/plugin/hooks/events-writer.ts, src/reducer.ts, src/db.ts, keeper/api.py, cli/jobs.ts, src/board-render.ts, plugins/plan/CLAUDE.md, plugins/plan/src/runtime_status.ts, README.md, test/exec-backend.test.ts, test/events-writer.test.ts, test/reducer-lifecycle.test.ts, test/refold-equivalence.test.ts, test/jobs.test.ts

### Approach

Add a durable `worktree` marker to each job, carrying the git lane BRANCH
(`keeper/epic/<id>[/<task>]`) the job ran in — NOT the lane path (which embeds a
provision-time dirhash and is torn down at finalize). This is the canonical "copy an
env-captured event field that folds onto jobs" change: it injects + reads like
`backend_exec_*` (producer → exec-backend `--x-tmux-env` → hook pure `process.env` read)
but SessionStart-gates + folds set-once like `config_dir`. Thread the branch end to end:

1. **Producer** (`src/autopilot-worker.ts`): pass `plan.worktree.assignment.branch` — the
   pure per-node branch, NOT anything derived from the realpath'd `launchCwd` — as a new
   `worktreeBranch?` onto the `LaunchSpec` via `buildPlannedLaunchSpec`, using the
   existing `...(x !== undefined && x !== "" ? { x } : {})` conditional-spread idiom.
2. **exec-backend** (`src/exec-backend.ts`): add `worktreeBranch?` to `AgentwrapLaunchOpts`
   and the spec→opts map; in the agentwrap argv builder emit a THIRD
   `--x-tmux-env KEEPER_PLAN_WORKTREE_BRANCH=${opts.worktreeBranch ?? ""}` immediately
   after the existing path env. CRITICAL: emit it UNCONDITIONALLY with `?? ""` (never the
   conditional-spread) so a serial/OFF launch reusing a tmux session OVERWRITES any stale
   branch a prior worktree launch left — the same reason the path env is already
   always-emitted.
3. **Hook** (`plugins/keeper/plugin/hooks/events-writer.ts`): SessionStart-gate the capture
   (`hookEvent === "SessionStart" ? worktreeBranchFromEnv(env) : null`), reading
   `KEEPER_PLAN_WORKTREE_BRANCH` as `(raw ?? "").trim() || null` (empty/whitespace/unset →
   NULL; NO trailing-slash normalization — it is a canonical ref). Add `worktree` to BOTH
   lockstep whitelists (`EVENT_KEYS` and `KNOWN_EVENT_COLUMNS`) and the dead-letter
   `bindings` key set. Stay `node:*`-only, pure `process.env`, no git, no `bun:sqlite`.
4. **Reducer** (`src/reducer.ts`): fold into the SessionStart
   `INSERT INTO jobs (… worktree …) ON CONFLICT DO UPDATE SET worktree =
   COALESCE(excluded.worktree, jobs.worktree)` arm (mirror `config_dir` exactly —
   excluded-first ordering, value bound in the params array). Do NOT touch the every-event
   `backend_exec_*` arm: set-once is load-bearing for resume (a resume emits empty → NULL →
   COALESCE preserves the first-launch branch).
5. **Schema** (`src/db.ts` + `keeper/api.py`): bump `SCHEMA_VERSION` 93→94; add a
   `// v93→v94:` migration step running `addColumnIfMissing(db, "events", "worktree",
   "TEXT")` and `addColumnIfMissing(db, "jobs", "worktree", "TEXT")` (pure additive
   nullable, NO default, NO cursor rewind — do NOT add to the rewind-and-redrain DELETE
   list; follow the prior usage-column add). Append `94` to `SUPPORTED_SCHEMA_VERSIONS` in
   `keeper/api.py` in the SAME commit.
6. **TUI** (`cli/jobs.ts` / `src/board-render.ts`): add a worktree pill to `projectJobRow`
   mirroring `backendCoordsSeg` — render `[⑂ <remainder>]` where remainder = the stored
   branch with the `keeper/epic/` prefix stripped (so `keeper/epic/fn-986/fn-986.2` →
   `⑂ fn-986/fn-986.2`; base lane `keeper/epic/fn-986` → `⑂ fn-986`); NULL → "" (no pill).
   Reuse `pill` / `pillOrEmpty`; bracket so `colorizePillsInLine` styles it.
7. **Docs**: amend `plugins/plan/CLAUDE.md:46` in-place (split the claim — the path env stays
   never-folded; the new branch env is the captured durable `jobs.worktree` value); add a
   one-sentence addendum at `plugins/plan/src/runtime_status.ts:13`; in `README.md`
   enumerate the new env→column→fold alongside `config_dir`, add a v94 changelog paragraph
   (the `backend_exec_*` block is the template), and add the `[⑂ …]` pill to the
   omit-default pill section.

### Investigation targets

**Required** (read before coding):
- src/types.ts:233,:250-265,:406,:442-454 — `Event.config_dir` / `backend_exec_*`, `Job.config_dir` / `backend_exec_*`; add `worktree: string | null` to both, mirror the `config_dir` doc-comment shape.
- src/autopilot-worker.ts:2292,:2323-2329,:369-385,:1984 — branch in scope (`plan.worktree.assignment.branch`) at the realpath line; `buildPlannedLaunchSpec` signature + call site; the geometry stamp. Thread `worktreeBranch?`.
- src/exec-backend.ts:849-856,:782,:1047-1048,:78-105 — the always-emit `?? ""` path-env precedent; `AgentwrapLaunchOpts.worktreePath`; spec→opts conditional spread; `LaunchSpec` interface.
- plugins/keeper/plugin/hooks/events-writer.ts:210,:259,:727,:762-796,:536,:561 — `configDirFromEnv`, `backendExecCoordsFromEnv`, the SessionStart gate, the `bindings` object, `KNOWN_EVENT_COLUMNS`, `EVENT_KEYS`.
- src/reducer.ts:7381-7448 — the SessionStart `INSERT … ON CONFLICT … COALESCE` for `config_dir` (clause ~:7386, binding ~:7441). Mirror exactly.
- src/reducer.ts:8104-8122 — the every-event `backend_exec_*` arm; READ to confirm you do NOT add `worktree` here.
- src/db.ts:49,:5387-5404,:3860-3865,:1969 — `SCHEMA_VERSION`; the prior usage add (no-rewind precedent) + the version-stamp site; the `backend_exec_*` column-add template; `addColumnIfMissing`.
- src/worktree-plan.ts:336-343,:130-145 — close-sink branch === `baseBranch`; `baseBranchFor` / `ribBranchFor` (confirms the stored-value shape: closer/inheriting → base, rib → `<base>/<task>`).
- keeper/api.py:371-380 — `SUPPORTED_SCHEMA_VERSIONS` frozenset + comment block.
- cli/jobs.ts:164-195,:217-224 — `projectJobRow` (the `(cwd)` basename seg) and `backendCoordsSeg` (the pill template).

**Optional** (reference as needed):
- src/board-render.ts — pill / section composition + `colorizePillsInLine`.
- README.md ~61-90, ~843-960, ~2259-2296 — env-to-event narrative, jobs pill section, the `backend_exec_*` schema-changelog template.

### Risks

- Stale-branch leak across reused tmux sessions if the branch env is emitted conditionally instead of always-`?? ""` — the highest-impact correctness bug; mirror the path env's unconditional emit exactly.
- Forgetting one of the three lockstep gates (`EVENT_KEYS` + `KNOWN_EVENT_COLUMNS`, the dead-letter `bindings`, and `SUPPORTED_SCHEMA_VERSIONS`) — each fails a pinned test loudly, but hit all three in the one commit.
- Adding `worktree` to the wrong fold arm (the every-event `backend_exec_*` arm instead of the SessionStart set-once INSERT) would wipe the branch to NULL on every resume.

### Test notes

- exec-backend argv: update test/exec-backend.test.ts:585-644 expected-argv arrays for the new third `--x-tmux-env` (branch set when in worktree mode; empty in serial).
- events-writer lockstep: test/events-writer.test.ts + test/events-ingest-worker.test.ts pin `EVENT_KEYS` ≡ `KNOWN_EVENT_COLUMNS` ≡ live `events` columns — they validate the whitelist add.
- reducer fold: add a case mirroring test/reducer-lifecycle.test.ts:646-689 — SessionStart sets `jobs.worktree` from the event; a resume with empty/NULL env preserves it via COALESCE; a non-worktree SessionStart leaves NULL.
- re-fold: test/refold-equivalence.test.ts must cover the new deterministic-replayed `jobs` column (pre-v94 events fold to NULL identically).
- pill: add a test/jobs.test.ts case for `projectJobRow` — base lane → `[⑂ fn-N]`, rib → `[⑂ fn-N/fn-N.M]`, NULL → no pill.
- schema: test/schema-version.test.ts stays green with 94 in `keeper/api.py`.

## Acceptance

- [ ] `events.worktree` and `jobs.worktree` exist (nullable TEXT, no default) after migrate; `SCHEMA_VERSION` is 94 and 94 is in `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`.
- [ ] A worktree-mode launch folds `jobs.worktree` to the verbatim lane branch (`keeper/epic/<id>` for base/inheriting/closer, `keeper/epic/<id>/<task>` for a rib); a serial / non-worktree launch folds NULL.
- [ ] The branch env is emitted unconditionally (`?? ""`) so a reused session never inherits a stale branch; a resume preserves the first-launch branch via set-once COALESCE.
- [ ] The capture is SessionStart-gated and added to both `EVENT_KEYS` and `KNOWN_EVENT_COLUMNS` and the dead-letter `bindings`; events-writer stays `node:*`-only with no git / `bun:sqlite` import.
- [ ] `keeper jobs` renders `[⑂ <branch minus keeper/epic/>]` for a worktree job and no pill for a NULL / non-worktree job.
- [ ] `plugins/plan/CLAUDE.md:46` and `plugins/plan/src/runtime_status.ts:13` are amended to distinguish the never-folded path env from the captured branch env; README documents the env→column→fold→pill arc + v94.
- [ ] Re-fold of a DB with pre-v94 events leaves `jobs.worktree` byte-identical (NULL where absent); the refold-equivalence test covers the column.
- [ ] Full `bun test` is green (exec-backend argv, events-writer lockstep, reducer fold, jobs pill, schema-version, refold-equivalence).

## Done summary
Added a durable per-job worktree-lane BRANCH marker (schema v94): producer injects KEEPER_PLAN_WORKTREE_BRANCH, the hook captures it at SessionStart into events.worktree, the reducer folds it set-once onto jobs.worktree via COALESCE, and keeper jobs renders a [⑂ <lane>] pill. Stores the branch (survives worktree remove/move), never the dirhash-bearing path.
## Evidence
