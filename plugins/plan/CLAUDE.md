keeper plan — File-based task tracking for structured development workflows.

## Doc & comment style

The canonical comment + doc discipline (default to no comments, WHY-only, never provenance/narration, prune on touch, protected-comment allowlist, docs prune never append-only) lives once in `template/agents/worker.md.tmpl`'s `## Doc & comment discipline` block — every prompt surface echoes it; never fork a divergent wording. **Never write backward-facing advice.** Docs, comments, skills, agent prompts, and diagram labels describe the system as it is *now* — never by reference to what was removed, renamed, or previously true. No "X used to…", "formerly Y", "replaces the prior Z", "no longer carries…", "(deleted in fn-N)", "(now removed)", or a feature defined only by negating a dead one. State the present-tense fact; if a constraint matters, phrase it as a forward rule ("there is no `--no-push` flag"), not as a tombstone. The one sanctioned exception is the "Removed verbs (do not re-add)" guardrail list below — it exists precisely to carry history.

## Convention Divergences

These diverge from standard arthack conventions:

- **`cat` is format-free** — always emits raw markdown to stdout regardless of `--format`. FormattedGroup auto-injects `--format` so the flag appears in `cat --help`, but the cat verb ignores it.
- **`validate` envelope is non-`success`** — emits `{"valid": bool, "errors": [...], "warnings": [...]}` instead of the standard `{"success": bool, ...}`, exiting 1 on `valid: false`. Routes through the formatter directly (not `emit()`) to preserve the shape.
- **Bare verb subcommand names** — `init`, `status`, `claim`, etc. instead of arthack's `verb-noun`. Established in the spec and referenced by orchestration scripts; do not rename.
- **Single implementation** — the compiled TypeScript dispatcher under `src/` is the sole runtime, reached in-process via `keeper plan`. The bun:test suite under `test/` is the living conformance surface.

## Commit behavior

Every mutating verb auto-commits its own data-dir scope inline at `output.emit()` (`chore(plan): <op> <target>`); a success envelope on stdout means the commit landed, and callers never wildcard-commit plan state.

## Data directory

The convention data dir is `.keeper/`. **Resolution and write-back live in one seam — `src/state_path.ts`** (`DATA_DIR = ".keeper"`, the single member of `DATA_DIR_NAMES`). Reads, detection, and write-back all target `.keeper/`; a root with no `.keeper/` yet defaults to minting one on the first write.

## Validation marker

`normalizeEpic` defaults `last_validated_at: null`. `scaffold` stamps it on fresh epic mint as part of its inline post-write integrity check — there is no trailing `validate --epic` step after `scaffold` on either the `/plan:plan` create path or the `/plan:close` follow-up scaffold. The 14 verbs in `src/validation_restamp.ts::VALIDATION_RESTAMP_VERBS` (canonical list — do not duplicate here) RE-STAMP the marker to a fresh microsecond-precision `now_iso()` after their post-write integrity check passes. `epic invalidate` and `refine-context --invalidate` are the two surviving paths that null the marker (the `--invalidate` flag flips the otherwise read-only verb into a conditionally-mutating one, following `validate --epic`'s precedent). Notable non-members: `done`, `claim`, `block`, `unblock` (the resume mirror of `block` — flips a blocked task back to `todo` preserving claim history; like `block` it does NOT re-stamp `last_validated_at`), `epic close`, and `scaffold` (mints via its own path, never the restamp helper).

`validate --epic` and `refine-context --invalidate` are both conditionally-mutating verbs: when the flag is absent or the precondition is already satisfied the verb is read-only and emits no commit; when the flag fires and a write is needed, the runner manually invokes `auto_commit_from_invocation` to land a single `.keeper/` commit. `validate --epic` writes the stamp BEFORE its auto-commit (inverse of the restamp-helper shape) — on commit failure the stamp persists on disk and a re-run short-circuits silently; the next mutating verb's auto-commit sweeps the dirty file.

## Skills and agents

`plan:*` skills live under `skills/`; the four worker agents and the auditor/planner/scout/panel-runner/panel-judge agents live in `agents/`. Tier routing rides the emitted `worker_agent` name, the orchestrator is content-blind, and `/plan:close` runs the audit inline before the irreversible `epic close`. The plugin's `hooks/` layer enforces the content-blind orchestrator contract mechanically: a PreToolUse commit hard-deny, a SubagentStop worker guard, and a Stop checklist guard keep all implementation work inside the worker subagent. Separately, the keeper plugin's `PreToolUse(Bash)` branch-guard hook hard-denies a worker subagent from git branch create/switch, enforcing the worker "work in place" invariant mechanically.

`/plan:hack` (`skills/hack/SKILL.md`) is a hand-authored STATIC skill — no `.tmpl`, no `.managed-file-dont-edit` sidecar — that investigates a request, answers in the right shape, and routes or executes the next move. It is slash-only (`disable-model-invocation: true`). Once an epic lands the wrap-up is quiet by default: autopilot dispatches and completes all plan work, so the planning flow never proactively surprise-launches execution mid-plan — no `/plan:work`, no unsolicited surfacing of the operator skills. The `keeper:dispatch` / `keeper:autopilot` operator skills are model-invocable and may be reached on clear user intent, but never from the planning flow on its own. The skill arms a `keeper:await` only on a positive wait-then-act call (and asks once when ambiguous, else stays quiet), and runs an always-on close-signal that speaks a single closing line only when nothing in the thread is left. It bakes three shared `keeper prompt` snippets (`keeper-history-forensics` inlined; `escalate-inline-or-plan` and `commit-via-keeper-default` baked verbatim), each under a `Canonical source: keeper prompt render engineering/<name>` cite line that is the only drift guard.

## Removed verbs (do not re-add)

`start` (→ `claim`), `next`, `activity`, `scout`, `interview`, `config show`, `draft from-close`, `epic publish`, `epic create --draft`, `epic.draft` field, `epic auditor-done`, `migrate-audit-grandfathering`, `audit-guard`, `close-context`, `epic close --audit-required`/`--no-audit-required`, `epic.auditor_done_at` field, `task create`, `task set-spec`, `task set-deps`, `epic set-plan`, `dep add` (whole `dep` group), `gravity`, `classifier` (agent + `skills/close/classifier/` schema — the close-planner absorbs vet/cull/merge + verdict authoring), `epic followup-of` (the partial-follow-up completeness check is ported into `close-finalize`), `epic set-snippets`, `epic set-bundles`, `task set-snippets`, `task set-bundles`, `scaffold --snippets`/`--bundles` flags, `epic queue-jump` + the `/plan:next` skill + `epic.queue_jump` field (board priority lives on the autopilot surface, never plan metadata). Their structural effects ride `scaffold` (mint a fresh epic + tasks) and `refine-apply` (add/rewrite on an existing epic). Epic-level deps keep `epic add-dep` / `epic add-deps` / `epic rm-dep`.

The no-incremental-mutation stance above is NOT a no-delete stance. `keeper plan epic rm <epic_id>` is the sanctioned — and only — delete verb: it unlinks every artifact an epic owns (epic JSON, every child task JSON, epic + task spec markdowns, runtime state, lock files) and auto-commits the deletions into the owning project's `.keeper/` via the standard envelope path. Resolves cwd-then-global with a `--project` escape, guards `in_progress` / locked tasks behind `--force`, and supports `--dry-run`. Companion guard on the create side: `scaffold` rejects a same-slug sibling epic up front with `duplicate_epic` (naming the existing id + status); `--allow-duplicate` is the explicit escape hatch.

## Environment variables

- `KEEPER_PLAN_ACTOR` overrides actor identity.
- `KEEPER_PLAN_NOW` overrides the clock source for all timestamp stamping in `%Y-%m-%dT%H:%M:%S.%fZ` format; any conforming implementation must honor it.
- `KEEPER_PLAN_WORKTREE` overrides the worktree-mode lane PATH for a worker's `target_repo` ONLY (via `expectedWorkerCwd`): when set non-empty it wins over the ordinary fallback chain so concurrent lanes don't collide in the shared main checkout. Plan STATE (`primary_repo` / `state_repo` in resolve-task / worker-resume / reconcile) always resolves to the primary repo from `epic.primary_repo`, never the lane. Producer-only (set at the worker's child boundary by autopilot worktree mode, realpath-normalized); the PATH is NEVER written to the event log as a fold key (it embeds a provision-time dirhash and is torn down at finalize). Empty/unset falls through to the fallback chain unchanged.
- `KEEPER_PLAN_WORKTREE_BRANCH` is the sibling marker env carrying the lane BRANCH (`keeper/epic/<id>[--<task>]`). Unlike the path above it IS a captured durable value: the hook reads it at SessionStart into `events.worktree`, folded set-once onto `jobs.worktree` (the branch survives `git worktree remove`/`move` where the path dangles). Producer-only, always-emitted (empty on serial launches so a reused tmux session never inherits a stale branch).

## Running Things

| What | Command |
|------|---------|
| Lint | `bun run lint` — biome check over `src` (and the hook dispatchers) |
| Typecheck | `bun run typecheck` — `tsc --noEmit` |
| Test (fast gate) | `bun test` — the living suite, fully in-process + zero real git; the only skips are the real-git slow-tier blocks gated `describe.skipIf(!SLOW_ENABLED)` (src-commit.test.ts's `autoCommitFromInvocation` blocks + worktree-lifecycle.test.ts) |
| Test (real-git slow tier) | `bun run test:slow` (`KEEPER_PLAN_RUN_SLOW=1 bun test`) — adds the real-git blocks with no fake-VCS analogue: src-commit.test.ts's commit path (index.lock contention-retry + prev-sha resolution) and worktree-lifecycle.test.ts's full lane cycle (provision → claim-in-lane → commit → merge → teardown under polluted GIT_*). No `bun run build` needed — no test spawns the compiled binary |
| Build | `bun run build` — compiles `dist/keeper-plan-bun` via `bun build --compile` (Bun pinned at 1.3.14) |
