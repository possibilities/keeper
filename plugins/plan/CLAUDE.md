planctl — File-based task tracking for structured development workflows.

## Doc & comment style

The canonical comment + doc discipline (default to no comments, WHY-only, never provenance/narration, prune on touch, protected-comment allowlist, docs prune never append-only) lives once in `template/agents/worker.md.tmpl`'s `## Doc & comment discipline` block — every prompt surface echoes it; never fork a divergent wording. **Never write backward-facing advice.** Docs, comments, skills, agent prompts, and diagram labels describe the system as it is *now* — never by reference to what was removed, renamed, or previously true. No "X used to…", "formerly Y", "replaces the prior Z", "no longer carries…", "(deleted in fn-N)", "(now removed)", or a feature defined only by negating a dead one. State the present-tense fact; if a constraint matters, phrase it as a forward rule ("there is no `--no-push` flag"), not as a tombstone. The one sanctioned exception is the "Removed verbs (do not re-add)" guardrail list below — it exists precisely to carry history.

## Convention Divergences

These diverge from standard arthack conventions:

- **`planctl cat` is format-free** — always emits raw markdown to stdout regardless of `--format`. FormattedGroup auto-injects `--format` so the flag appears in `cat --help`, but `run_cat.py` ignores it.
- **`planctl validate` envelope is non-`success`** — emits `{"valid": bool, "errors": [...], "warnings": [...]}` instead of the standard `{"success": bool, ...}`, exiting 1 on `valid: false`. Routes through `format_output` directly (not `emit()`) to preserve the shape.
- **Bare verb subcommand names** — `init`, `status`, `claim`, etc. instead of arthack's `verb-noun`. Established in the spec and referenced by orchestration scripts; do not rename.
- **Single implementation** — `planctl-bun` (compiled TypeScript under `src/`) is the sole runtime, installed at `~/.local/bin/planctl`. The bun:test suite under `test/` is the living conformance surface.

## Commit behavior

Every mutating verb auto-commits its own data-dir scope inline at `output.emit()` (`chore(plan): <op> <target>`); a success envelope on stdout means the commit landed, and callers never wildcard-commit planctl state.

## Data directory

The convention data dir is `.keeper/`; a transient `.planctl/` fallback keeps boards minted before the rename usable during the migration window. **Resolution and write-back live in one seam — `src/state_path.ts`.** Reads/detect resolve `.keeper/` first, then `.planctl/` (deterministic precedence: `.keeper/` wins when both exist at one root). **Writes write BACK to the dir the board already resolves to** — a repo still on `.planctl/` keeps writing to `.planctl/`; only a fresh `init` where neither dir exists defaults to `.keeper/`. Never force `.keeper/` on a legacy board (it spawns a shadow dir that hides the live one); the dir migration happens solely via an explicit `git mv .planctl .keeper`.

## Validation marker

`normalize_epic` defaults `last_validated_at: null`. `scaffold` stamps it on fresh epic mint as part of its inline post-write integrity check — there is no trailing `validate --epic` step after `scaffold` on either the `/plan:plan` create path or the `/plan:close` follow-up scaffold. The 14 verbs in `planctl/validation_restamp.py::VALIDATION_RESTAMP_VERBS` (canonical list — do not duplicate here) RE-STAMP the marker to a fresh microsecond-precision `now_iso()` after their post-write integrity check passes. `epic invalidate` and `refine-context --invalidate` are the two surviving paths that null the marker (the `--invalidate` flag flips the otherwise read-only verb into a conditionally-mutating one, following `validate --epic`'s precedent). Notable non-members: `done`, `claim`, `block`, `epic close`, and `scaffold` (mints via its own path, never the restamp helper).

`validate --epic` and `refine-context --invalidate` are both conditionally-mutating verbs: when the flag is absent or the precondition is already satisfied the verb is read-only and emits no commit; when the flag fires and a write is needed, the runner manually invokes `auto_commit_from_invocation` to land a single `.planctl/` commit. `validate --epic` writes the stamp BEFORE its auto-commit (inverse of the restamp-helper shape) — on commit failure the stamp persists on disk and a re-run short-circuits silently; the next mutating verb's auto-commit sweeps the dirty file.

## Skills and agents

`plan:*` skills live under `skills/`; the four worker agents and the auditor/planner/scout/panel-judge agents live in `agents/`. Tier routing rides the emitted `worker_agent` name, the orchestrator is content-blind, and `/plan:close` runs the audit inline before the irreversible `epic close`. The plugin's `hooks/` layer enforces the content-blind orchestrator contract mechanically: a PreToolUse commit hard-deny, a SubagentStop worker guard, and a Stop checklist guard keep all implementation work inside the worker subagent. Separately, the keeper plugin's `PreToolUse(Bash)` branch-guard hook hard-denies a worker subagent from git branch create/switch, enforcing the worker "work in place" invariant mechanically.

`/plan:hack` (`skills/hack/SKILL.md`) is a hand-authored STATIC skill — no `.tmpl`, no `.managed-file-dont-edit` sidecar — that investigates a request, answers in the right shape, and routes or executes the next move. It is slash-only (`disable-model-invocation: true`). Once an epic lands the wrap-up is quiet by default: autopilot dispatches and completes all plan work, so the planning flow never proactively surprise-launches execution mid-plan — no `/plan:work`, no unsolicited surfacing of the operator skills. The `keeper:dispatch` / `keeper:autopilot` operator skills are model-invocable and may be reached on clear user intent, but never from the planning flow on its own. The skill arms a `keeper:await` only on a positive wait-then-act call (and asks once when ambiguous, else stays quiet), and runs an always-on close-signal that speaks a single closing line only when nothing in the thread is left. `/plan:next` is recommended only in the defer context, to flip an already-deferred epic to the front of the board. It bakes three shared promptctl snippets (`keeper-history-forensics` inlined; `escalate-inline-or-plan` and `commit-via-keeper-default` baked verbatim), each under a `Canonical source: promptctl render engineering/<name>` cite line that is the only drift guard.

## Removed verbs (do not re-add)

`start` (→ `claim`), `next`, `activity`, `scout`, `interview`, `config show`, `draft from-close`, `epic publish`, `epic create --draft`, `epic.draft` field, `epic auditor-done`, `migrate-audit-grandfathering`, `audit-guard`, `close-context`, `epic close --audit-required`/`--no-audit-required`, `epic.auditor_done_at` field, `task create`, `task set-spec`, `task set-deps`, `epic set-plan`, `dep add` (whole `dep` group), `gravity`, `classifier` (agent + `skills/close/classifier/` schema — the close-planner absorbs vet/cull/merge + verdict authoring), `epic followup-of` (the partial-follow-up completeness check is ported into `close-finalize`), `epic set-snippets`, `epic set-bundles`, `task set-snippets`, `task set-bundles`, `scaffold --snippets`/`--bundles` flags. Their structural effects ride `scaffold` (mint a fresh epic + tasks) and `refine-apply` (add/rewrite on an existing epic). Epic-level deps keep `epic add-dep` / `epic add-deps` / `epic rm-dep`.

The no-incremental-mutation stance above is NOT a no-delete stance. `planctl epic rm <epic_id>` is the sanctioned — and only — delete verb: it unlinks every artifact an epic owns (epic JSON, every child task JSON, epic + task spec markdowns, runtime state, lock files) and auto-commits the deletions into the owning project's `.planctl/` via the standard envelope path. Resolves cwd-then-global with a `--project` escape, guards `in_progress` / locked tasks behind `--force`, and supports `--dry-run`. Companion guard on the create side: `scaffold` rejects a same-slug sibling epic up front with `duplicate_epic` (naming the existing id + status); `--allow-duplicate` is the explicit escape hatch.

## Environment variables

- `KEEPER_PLAN_ACTOR` (legacy fallback `PLANCTL_ACTOR`) overrides actor identity.
- `KEEPER_PLAN_NOW` (legacy fallback `PLANCTL_NOW`) overrides the clock source for all timestamp stamping in `%Y-%m-%dT%H:%M:%S.%fZ` format; any conforming implementation must honor it. The new name takes precedence; the legacy name is read only as a transient migration fallback.

## Running Things

| What | Command |
|------|---------|
| Lint | `bun run lint` — biome check over `src` (and the hook dispatchers) |
| Typecheck | `bun run typecheck` — `tsc --noEmit` |
| Test (fast gate) | `bun test` — the living suite; slow-bucket tests (`real_git`/`integration`/`wire`) skip-by-default, visible as skips |
| Test (full suite) | `PLANCTL_RUN_SLOW=1 bun test` — runs everything incl. the slow bucket (real git/wire machinery) |
| Build | `bun run build` — compiles `dist/planctl-bun` via `bun build --compile` (Bun pinned at 1.3.14) |
| Promote | `bun run promote` — builds `dist/planctl-bun` (hard prerequisite), then atomically installs it over the `~/.local/bin/planctl` path entry; logs the promoted `git rev-parse HEAD` |

## Bun cutover runbook

`~/.local/bin/planctl` is the compiled bun binary, promoted by `scripts/promote.sh` (`bun run promote`). The script builds `dist/planctl-bun` as a hard prerequisite in the same invocation, copies it to `~/.local/bin/.planctl.tmp` (temp in the destination dir → same-filesystem atomic rename), `mv -f` over the `~/.local/bin/planctl` path entry (replacing whatever is there — symlink or regular file — without following it), `chmod +x`, and logs the promoted `git rev-parse HEAD`. Any step failing aborts non-zero and leaves the live binary intact.

- **Promote**: `bun run promote`
- **Rollback**: the production binary `~/.local/bin/planctl` is replaced atomically by `bun run promote`, so a bad promote is undone by promoting a known-good revision (`git checkout <good-sha> -- . && bun run promote`). The Python reference implementation lives only in git history behind a single purely-subtractive deletion commit; `git revert <deletion-sha>` restores it as a parity/rollback target.
- **Shell cache**: long-lived shells cache the resolved path. Run `hash -r` (bash) or `rehash` (zsh) after a promote or rollback to drop the cache. Already-exec'd processes hold their inode and are immune.

**Rollback triggers** (any one → roll back to a known-good revision immediately, no debate, then surface loudly):

- any non-zero exit on a known-good verb during the soak or first hour,
- any `Uncaught` / `error:` / `Traceback` stderr pattern from planctl,
- p95 invocation time > 2× the rehearsal baseline (measure a 20-invocation `planctl status` baseline against the live shim pre-swap; compare warmed steady-state post-swap, discounting the one-time cold-start of the binary's first exec).

**Soak**: after promote, run the full workflow cycle (init → scaffold → claim → done → close-preflight → audit submit → verdict submit → close-finalize) in a scratch project in its OWN fresh git repo (auto-commits need it; isolation keeps auto-commit failures from confounding the signal). `claim` is cwd-agnostic and resolves through configured roots, so a scratch repo outside the roots needs `claim <task_id> --project <scratch_repo>`. Watch non-zero exit rate by verb, warmed steady-state p95, and the stderr patterns above through the first hour.
