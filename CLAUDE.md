planctl — File-based task tracking for structured development workflows.

## Doc & comment style

The canonical comment + doc discipline (default to no comments, WHY-only, never provenance/narration, prune on touch, protected-comment allowlist, docs prune never append-only) lives once in `template/agents/worker.md.tmpl`'s `## Doc & comment discipline` block — every prompt surface echoes it; never fork a divergent wording. **Never write backward-facing advice.** Docs, comments, skills, agent prompts, and diagram labels describe the system as it is *now* — never by reference to what was removed, renamed, or previously true. No "X used to…", "formerly Y", "replaces the prior Z", "no longer carries…", "(deleted in fn-N)", "(now removed)", or a feature defined only by negating a dead one. State the present-tense fact; if a constraint matters, phrase it as a forward rule ("there is no `--no-push` flag"), not as a tombstone. The one sanctioned exception is the "Removed verbs (do not re-add)" guardrail list below — it exists precisely to carry history.

## Convention Divergences

These diverge from standard arthack conventions:

- **`planctl cat` is format-free** — always emits raw markdown to stdout regardless of `--format`. FormattedGroup auto-injects `--format` so the flag appears in `cat --help`, but `run_cat.py` ignores it.
- **`planctl validate` envelope is non-`success`** — emits `{"valid": bool, "errors": [...], "warnings": [...]}` instead of the standard `{"success": bool, ...}`, exiting 1 on `valid: false`. Routes through `format_output` directly (not `emit()`) to preserve the shape.
- **Bare verb subcommand names** — `init`, `status`, `claim`, etc. instead of arthack's `verb-noun`. Established in the spec and referenced by orchestration scripts; do not rename.
- **Polyglot, single authority** — the Python CLI is the authoritative implementation; `planctl-bun` (compiled TypeScript under `src/`) is an additive port covering the read verbs (`state-path`, `detect`, `status`, `epics`) and the worker-loop writes (`init`, `claim`, `done`, `block`), proven at parity against the shared conformance suite. `claim`/`block` mutate only gitignored `state/` (zero commits); `done` and `init` self-commit byte-identical to Python in subject + trailer shape.

## Commit behavior

Every mutating verb auto-commits its own `.planctl/` scope inline at `output.emit()` (`chore(planctl): <op> <target>`); a success envelope on stdout means the commit landed, and callers never wildcard-commit planctl state.

## Validation marker

`normalize_epic` defaults `last_validated_at: null`. `scaffold` stamps it on fresh epic mint as part of its inline post-write integrity check — there is no trailing `validate --epic` step after `scaffold` on either the `/plan:plan` create path or the `/plan:close` follow-up scaffold. The 14 verbs in `planctl/validation_restamp.py::VALIDATION_RESTAMP_VERBS` (canonical list — do not duplicate here) RE-STAMP the marker to a fresh microsecond-precision `now_iso()` after their post-write integrity check passes. `epic invalidate` and `refine-context --invalidate` are the two surviving paths that null the marker (the `--invalidate` flag flips the otherwise read-only verb into a conditionally-mutating one, following `validate --epic`'s precedent). Notable non-members: `done`, `claim`, `block`, `epic close`, and `scaffold` (mints via its own path, never the restamp helper).

`validate --epic` and `refine-context --invalidate` are both conditionally-mutating verbs: when the flag is absent or the precondition is already satisfied the verb is read-only and emits no commit; when the flag fires and a write is needed, the runner manually invokes `auto_commit_from_invocation` to land a single `.planctl/` commit. `validate --epic` writes the stamp BEFORE its auto-commit (inverse of the restamp-helper shape) — on commit failure the stamp persists on disk and a re-run short-circuits silently; the next mutating verb's auto-commit sweeps the dirty file.

## Skills and agents

`plan:*` skills live under `skills/`; the four worker agents and the auditor/planner/scout agents live in `agents/`. Tier routing rides the emitted `worker_agent` name, the orchestrator is content-blind, and `/plan:close` runs the audit inline before the irreversible `epic close`. The plugin's `hooks/` layer enforces the content-blind orchestrator contract mechanically: a PreToolUse commit hard-deny, a SubagentStop worker guard, and a Stop checklist guard keep all implementation work inside the worker subagent.

## Removed verbs (do not re-add)

`start` (→ `claim`), `next`, `activity`, `scout`, `interview`, `config show`, `draft from-close`, `epic publish`, `epic create --draft`, `epic.draft` field, `epic auditor-done`, `migrate-audit-grandfathering`, `audit-guard`, `close-context`, `epic close --audit-required`/`--no-audit-required`, `epic.auditor_done_at` field, `task create`, `task set-spec`, `task set-deps`, `epic set-plan`, `dep add` (whole `dep` group), `gravity`, `classifier` (agent + `skills/close/classifier/` schema — the close-planner absorbs vet/cull/merge + verdict authoring), `epic followup-of` (the partial-follow-up completeness check is ported into `close-finalize`), `epic set-snippets`, `epic set-bundles`, `task set-snippets`, `task set-bundles`, `scaffold --snippets`/`--bundles` flags. Their structural effects ride `scaffold` (mint a fresh epic + tasks) and `refine-apply` (add/rewrite on an existing epic). Epic-level deps keep `epic add-dep` / `epic add-deps` / `epic rm-dep`.

The no-incremental-mutation stance above is NOT a no-delete stance. `planctl epic rm <epic_id>` is the sanctioned — and only — delete verb: it unlinks every artifact an epic owns (epic JSON, every child task JSON, epic + task spec markdowns, runtime state, lock files) and auto-commits the deletions into the owning project's `.planctl/` via the standard envelope path. Resolves cwd-then-global with a `--project` escape, guards `in_progress` / locked tasks behind `--force`, and supports `--dry-run`. Companion guard on the create side: `scaffold` rejects a same-slug sibling epic up front with `duplicate_epic` (naming the existing id + status); `--allow-duplicate` is the explicit escape hatch.

## Environment variables

- `PLANCTL_ACTOR` overrides actor identity.
- `PLANCTL_NOW` overrides the clock source for all timestamp stamping in `%Y-%m-%dT%H:%M:%S.%fZ` format; any conforming implementation must honor it.

## Running Things

| What | Command |
|------|---------|
| Lint | `uv run ruff check .` |
| Format | `uv run ruff format .` |
| Type check | `uv run ty check` |
| Test (fast gate) | `uv run pytest tests/` — default in-process engine, near-subprocess-free; slow-bucket tests (`real_git`/`integration`/`wire`) skip-by-default, visible as skips |
| Test (full suite) | `uv run pytest tests/ --run-slow` — runs everything incl. the slow bucket (real git/wire machinery) |
| Test (conformance) | `PLANCTL_BIN="$(command -v planctl)" uv run pytest tests/` — runs every non-`python_only` test against the real binary as a subprocess with real git; `python_only` tests skip-visible. Parallelise with `-n auto --dist loadscope` (per-worker tmp HOME, no cross-worker flock; `-n auto` capped at 8). Point `PLANCTL_BIN` at any planctl binary to run this suite as its parity spec |
| Bun build | `bun run build` — compiles `dist/planctl-bun` via `bun build --compile` (Bun pinned at 1.3.14) |
| Bun lint | `bun run lint` — biome check over `src` (and the hook dispatchers) |
| Bun typecheck | `bun run typecheck` — `tsc --noEmit` |
| Bun test | `bun run test` — `bun test` over the TypeScript suite |
| Bun conformance | `bun run build && PLANCTL_BIN="$PWD/dist/planctl-bun" uv run pytest tests/test_cli.py tests/test_readonly_verbs.py tests/test_init.py tests/test_worker_verbs.py --run-slow` — the scoped parity gate against the compiled binary (`--run-slow` runs `test_init.py`'s `real_git` commit tests; serial, add `-n auto --dist loadscope` to parallelise) |
