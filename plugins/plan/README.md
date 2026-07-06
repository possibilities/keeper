# plan

`keeper plan` is a file-based CLI for managing epics, tasks, dependencies, and markdown specs in structured software workflows.

- Data lives in `.keeper/` inside the project directory, under version control.
- Task runtime state is separated from task definitions.
- Spec changes are written in place to `specs/{id}.md`. Git provides the audit trail.
- Commands emit JSON by default. Pass `--format human` for human-readable output. `cat` always emits raw markdown.

## Requirements

- [Bun](https://bun.sh/) `1.3.14` — runs the compiled TypeScript dispatcher under `src/`

## Entrypoint

`keeper plan <verb>` is the canonical command. It runs the plan verb dispatcher in-process through the single `keeper` binary (`cli/plan.ts` imports `plugins/plan/src/cli.ts`); there is no separate standalone CLI on `PATH`.

```bash
keeper plan --help
```

## Quick Start

```bash
# 1) Initialize current project
keeper plan init

# 2) Scaffold an epic + its tasks in one transactional call
#    (plan.yaml: epic mapping + ordered tasks list, deps as 1-based ordinals)
keeper plan scaffold --file plan.yaml

# 3) Refine an existing epic later (add tasks, rewrite specs/deps)
keeper plan refine-apply fn-1-add-auth --file delta.yaml

# 4) Work the task lifecycle (claim asserts + claims + writes the worker brief, returns a brief_ref)
keeper plan claim fn-1-add-auth.1
keeper plan done fn-1-add-auth.1 --summary "Chose JWT strategy"

# 5) Inspect state
keeper plan list
keeper plan validate
```

## Command Map

Top-level commands:

- `init`, `detect`, `status`, `validate`, `state-path`
- `claim`, `resolve-task`, `reconcile`, `find-task-commit`, `done`, `block`, `unblock`, `epic-question`, `ready`
- `close-preflight`, `audit submit`, `verdict submit`, `followup submit`, `close-finalize`
- `show`, `epics`, `tasks`, `list`, `cat`
- `mv-repo`, `selection-brief`, `assign-cells`
- `epic`, `task`, `dep`

The board verb `unblock` (flips a task `blocked → todo`, preserving claim history) is distinct from the `/plan:unblock` escalation SKILL: autopilot dispatches the skill as an `unblock::<task>` session to resolve a blocked task autonomously, and that session may CALL the `unblock` board verb as one of its actions. Both escalation skills (`/plan:unblock`, `/plan:deconflict`) load their incident context from the keeper-core `keeper escalation-brief <verb>::<id>` command — NOT a `keeper plan` verb — which resolves the incident details, the transcript pointers, and the creator lineage, walking a closer creator back to the original creator with session ids and transcript paths for both.

`resolve-task <task_id>` (fn-593) — read-only routing lookup returning the subset of `claim`'s envelope an external consumer needs to route a worker and police cwd. A public CLI surface; the `arthack-claude.py` launcher does not call it (keeper reads `task.tier` from its own projected Task data for board/projection and launches workers with a per-cell `--plugin-dir` it resolves producer-side from the task's `{model, effort}` cell — the loaded `work` plugin is what routes the tier). Cwd-agnostic (scans configured `roots`); supports `--project <path>` to disambiguate. Returns `{task_id, epic_id, project_path, target_repo, primary_repo, tier, worker_model, worker_agent, status}` — `tier` is a configured effort or `null`, `worker_model` is a configured model or `null`, and `worker_agent` is the composed `plan:worker-<model>-<effort>` string retained as a null-either-axis gate signal (`null` when either axis is null), not a spawn target — `/plan:work` spawns the constant `work:worker` and the launcher selects the matching cell via `--plugin-dir`. No `.keeper/` write, no commit. Typed errors: `BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID | NOT_A_PROJECT`.

`reconcile <task_id>` (fn-6) — read-only post-worker verdict verb, the symmetric bookend to `claim`'s pre-worker brief handoff. Collapses the `/plan:work` orchestrator's post-worker reconciliation into one call returning a typed verdict the orchestrator switches on mechanically: `done | in_progress_committed | in_progress_uncommitted | blocked | state_uncommitted | not_started | tooling_error`. Computed entirely from plan-native data — merged status, trailer-authentic source commits (against `target_repo` + `epic.touched_repos`), HEAD-visibility of the committed task JSON (against `state_repo`), and an epic-progress tally — with NO keeper dependency. Any git subprocess failure fails closed to `tooling_error`. Cwd-agnostic (scans configured `roots`); supports `--project <path>` to disambiguate. Returns `{verdict, task_id, epic_id, status, source_commits, state_head_visible, epic_progress, assessed_at, blocked_reason}`. No `.keeper/` write, no commit. Typed errors: `BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID`.

`find-task-commit <task_id>` — read-only commit lookup for a single task. Wraps the native `Task:`-trailer scan and emits the flat envelope a worker's harness-drop predecessor-detection consumes: `{"success": true, "commits": [{"sha": "<%H>", "repo": "<abs-path>"}, ...]}` (`sha`/`repo` field names, full `%H`; repo-outer first-seen order, per-repo grep order, SHAs deduped per repo). A clean miss is a normal empty success (`commits: []`, exit 0). The verb fails loud (`COMMIT_LOOKUP_FAILED`, exit 1, with `details.broken_repos`) only when every repo in the resolved scan set is missing or not a git repo. Resolution is plan-native: the owning project is found cwd-agnostically via `find_projects_with_task` (`--project <abs>` to disambiguate), then `primary_repo` / `touched_repos` are read off the epic record to seed the scan set. No `.keeper/` write, no commit. Typed errors: `BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID | NOT_A_PROJECT`.

`mv-repo <old> <new>` — metadata-only board rewrite after a repo directory is renamed. It does NOT move any directory: the operator renames the dir, then this verb rewrites every stored board path in the current project — each epic's `primary_repo`, each `touched_repos` entry, and each task's `target_repo` matching `<old>` → `<new>` — re-validates every touched epic through the post-write integrity gate (the marker is left untouched), and lands the whole rewrite in ONE `chore(plan): mv-repo <new>` commit. Matching is by the `realpath`-canonicalized stored string, never a stat of `<old>` (it is gone by definition of a rename) and never lowercased (APFS is case-insensitive). `<new>` must exist and carry a `.git/` or the verb refuses loudly. Naturally idempotent — a re-run finds nothing matching `<old>` and is a no-op; `old == new` after canonicalization is likewise a no-op. This is the bulk-rename path: prefer it over per-epic `epic set-primary-repo` / per-task `task set-target-repo` when a whole repo moved.

`selection-brief <epic_id>` — content-blind handoff for the post-scaffold selector. It writes `.keeper/state/selections/<epic_id>/brief.json` (gitignored, commit-free) containing the selector policy config, epic spec, todo task specs, configured axes, candidate cells, and config/input hashes, then emits only `{brief_ref, config_hash, input_hash, shuffle_seed, task_ids, candidate_cells}`. `/plan:plan` and `/plan:defer` pass that handle to `plan:model-selector` instead of inlining spec prose. Typed errors: `BAD_EPIC_ID`, `NOT_A_PROJECT`, `AMBIGUOUS_EPIC_ID`, `EPIC_NOT_FOUND`, `CONFIG_MISSING`, `MATRIX_MISSING`, `EPIC_SPEC_MISSING`, `TASK_SPEC_MISSING`, `NO_TODO_TASKS`.

`assign-cells <epic_id> --file -` — batch-overwrite the `{tier, model}` cells of a ghost epic's todo tasks during the post-scaffold **select window**, landing the cell writes AND a git-committed selection sidecar in ONE auto-commit. Batch-only by contract: the YAML carries a `cells:` list covering EVERY todo task of the epic exactly once (choosing the default is an explicit cell) plus a `selection:` provenance block (selector source, config + input hashes, shuffle seed, outcome, raw verdict); it asserts the whole batch (assert-all, collect-all), mutates every task JSON under the epic flock, writes the schema-versioned sidecar to `.keeper/selections/<epic_id>.json`, then re-validates the tree through the post-write integrity gate — the marker is left untouched, so a ghost stays a ghost until the trailing `validate --epic` arm — no partial writes on any failure. There is no single-task form, which is what keeps it outside the removed incremental `task set-tier` class. Its callers are the `/plan:plan` (Phase 6.5) and `/plan:defer` (Phase 4b) select beats: the content-blind `plan:model-selector` subagent picks the cells from the brief, the beat feeds them here with `label_source: heuristic-guided`, and every selector failure degrades to the stamped defaults recorded with `label_source: heuristic-default`. Axis validation comes from the embedded subagents matrix only — the verb never reads `model-selector.yaml`. Typed errors: `bad_yaml` (shape/type), `cell_invalid` (out-of-axis tier/model, or an unknown / duplicate / missing / non-todo task id — the full-set + todo-only contract), `epic_not_found`.

The close phase (`/plan:close`) runs as five verbs the content-blind coordinator switches on. `close-preflight <epic_id>` is the pre-audit brief handoff (the bookend to `claim`): it confirms every task is `done`, scans each repo's `Task:`-trailer source commits — the epic lane branch `keeper/epic/<epic_id>` when that worktree lane is present, else `HEAD` — so a worktree epic's lane-only commits are visible before they merge to the default branch (a single-repo / non-worktree close is unchanged, and a post-merge re-run self-heals once the lane is pruned), writes the close-phase brief to `<primary_repo>/.keeper/state/audits/<epic_id>/brief.json` (commit-free, atomic) — the brief carries per-task `{id, title, status, target_repo, done_summary}` plus the epic's `touched_repos` on the root, the repo map the close-planner reads to route each follow-up task — and returns `{primary_repo, brief_ref, commit_set_hash, tasks, all_done}` — a not-all-done epic is a typed `TASKS_NOT_DONE` error. It also claims the close exclusively: a second concurrent closer for the same epic fails loud with `CLOSE_ALREADY_CLAIMED` while the first proceeds unaffected (`close-finalize` releases the claim on every terminal outcome — success or typed error — so a re-run re-claims cleanly). `audit submit` / `verdict submit` / `followup submit` persist the quality-auditor's report, the close-planner's verdict JSON, and its follow-up plan YAML under `audits/<epic_id>/`, each validating at emission with typed reject envelopes (commit-free, like `claim`). `close-finalize <epic_id>` encodes the saga from observable state — stale-check on `commit_set_hash` (`STALE_ARTIFACTS`), fatal-halt, reversible follow-up scaffold BEFORE the irreversible `epic close` — and returns one of four typed `CloseOutcome` members (`closed_clean | closed_with_followup | fatal_halt | partial_followup`); it is idempotent on re-run.

Subcommands:

- `epic`: `create`, `set-plan`, `set-branch`, `set-title`, `close`, `rm`, `add-dep`, `rm-dep`
- `task`: `create`, `set-description`, `set-acceptance`, `set-spec`, `reset`, `set-deps`
- `dep`: `add`
- `worker`: `resume`

## Storage Layout

All data lives in `.keeper/` inside the project directory:

```text
{project_root}/.keeper/
  meta.json
  epics/{epic-id}.json
  specs/{epic-id}.md
  specs/{task-id}.md
  tasks/{task-id}.json
  selections/{epic-id}.json # committed model+effort selection sidecars (assign-cells)
  state/                    # gitignored -- ephemeral runtime data
    tasks/{task-id}.state.json    # task runtime status
    epics/{epic-id}.state.json    # epic runtime sidecar
    selections/{epic-id}/brief.json # selector brief handoff (selection-brief)
    locks/{task-id}.lock
```

Specs are written in place to `specs/{id}.md` by commands that mutate spec content (`done`, `task set-description`, `task set-acceptance`, `task set-spec`, `task reset`, `epic set-plan`, `task create`, `epic create`). Git history provides the audit trail.

Environment variables:

- `KEEPER_PLAN_ACTOR` (override identity)
- `KEEPER_PLAN_NOW` (overrides the clock source for all timestamp stamping in `%Y-%m-%dT%H:%M:%S.%fZ` format; any conforming implementation must honor it)
- `CLAUDE_CODE_SESSION_ID` (sole source of the session id used to key the touched-paths log under `.keeper/state/sessions/<session_id>/`; required for every mutating verb except `init`, the session-id-free verb that builds its own commit payload — the claude binary ships it intrinsically on every session including resumed ones, tests and manual invocations set it explicitly)

## Auto-commit

Mutating verbs emit a `plan_invocation` NDJSON envelope on stdout scoped to that write, and land a `chore(plan): <op> <target>` commit inline at `output.emit()` via `auto_commit_from_invocation` — the commit happens BEFORE the success envelope prints, so the envelope's appearance on stdout is the authoritative signal that the `.keeper/` commit landed. Read-only / inspection verbs emit exactly one top-level JSON value and no `plan_invocation` trailer (nothing consumes it on a read, and a second root breaks `json.load` / `jq`). Runtime-only verbs like `claim`/`block` mutate but land no commit (`files` is empty → no-op). `claim` writes the worker brief to `<primary_repo>/.keeper/state/briefs/<task_id>.json` and returns a `brief_ref` handle, but that brief lives under gitignored `state/`, so it too lands no commit. On commit failure the runner prints a structured `{"success": false, "error": "commit_failed", "details": {...}}` envelope on stdout and exits 1 — the success envelope is NOT printed.

`init` is the session-id-free mutating verb: it builds its own commit payload directly (an explicit list of the bootstrap files it created), so it needs neither the touched-paths log nor `CLAUDE_CODE_SESSION_ID`. It lands a `chore(plan): init <project-name>` commit with no `Session-Id:` trailer, but only when it wrote something AND the cwd is inside a git work tree — an idempotent re-run or an `init` in a non-git dir takes the read-only path with no commit.

For source-code commits from worker agents, use `keeper commit-work`:

```bash
# Preview what will be staged
keeper commit-work --preview-files

# Commit with a message (auto-pushes to origin on success)
keeper commit-work "feat(scope): add the feature

Task: fn-N-slug.M"
```

On success, `keeper commit-work` emits two NDJSON envelopes on stdout — the
commit envelope (`{success, commit_sha, files}`) and the push envelope
(`{success, pushed, remote, branch}`). If the branch has no upstream, it is
auto-set via `git push -u origin HEAD` on the first push. On push failure the
exit code is 1 and the push envelope carries `push_error_class` (one of
`non_fast_forward | auth | hook_rejected | no_upstream | network | other`) plus
verbatim stderr; the caller resolves inline (rebase/pull/auth fix) before
retrying. There is no `--no-push` flag; `GIT_TERMINAL_PROMPT=0` is set on every
push subprocess so non-TTY invocations fail fast instead of hanging on a
prompt.

**Escape hatch — if `commit-work` won't stage the full file set, drop to git directly.** `commit-work` scopes to session-touched files; if it leaves out a file you need in the commit (or stages the wrong set), don't fight it — commit with plain `git` instead. Stage only the files you're committing, by explicit path (`git add <path> …` — never `git add -A` / `git add .`), then `git commit` and `git push`. This is a temporary escape hatch we'll repair; for now you're empowered to use git directly whenever `commit-work` can't cover what you need. **A lint failure is never a coverage gap.** When the commit-work envelope reports `"error": "lint_failed"`, this fallback does not apply — the only permitted recovery is: fix the reported lint errors, re-stage with `git add`, and re-invoke `keeper commit-work` with the same message. Never bare `git commit` or `--no-verify` after a lint failure.

## Version Control Advice

**Do not gitignore `.keeper/`.** Plan data is meant to be committed -- the `state/` subdirectory already has its own `.gitignore` for ephemeral runtime files (locks, active task state).

If you use a context-dump tool, add `.keeper/` to its ignore file so plan data doesn't flood your context.

## Output Contract

Commands emit JSON by default:

- Success: `{"success": true, ...}`
- Failure: `{"success": false, "error": "..."}` for a single-code commit failure; the accumulate-all failure path (scaffold / refine-apply) emits the converged error OBJECT `{"success": false, "error": {"code", "message", "details": [...], "recovery"}}` — `recovery` is an actionable next step keyed on `code` (see `docs/problem-codes.md`).
- Non-JSON failures print `Error: ...` to stderr and exit non-zero.

The plan `emit()` family is deliberately exempt from keeper's shared one-shot envelope (`{schema_version, ok, error, data}` in `cli/envelope.ts`): its `{success, ...data, plan_invocation}` shape is frozen for Python byte-parity and the one-JSON-root guard, and converges with the shared surface only on the error sub-object's `{code, message, recovery}` fields.

**Every read-only / inspection verb emits exactly one top-level JSON value** — one root, zero trailing bytes, so `json.load` and `jq` parse it cleanly (a second root raises "Extra data"). A conformance guard asserts this by parsing roots, not counting lines (a single pretty-printed value spans many lines). Provenance never rides the result stream: read verbs carry no `plan_invocation` trailer.

`keeper plan list` and `keeper plan tasks` bound their output with a `{total, returned, truncated, hint}` envelope wrapping the rows — `truncated: true` and a `hint` string signal a capped set. The `--format human` render is byte-unchanged.

Pass `--format human` for human-readable text/tables.
`cat` always emits raw markdown regardless of `--format`.
`validate` uses a custom envelope: `{"valid": bool, "errors": [...], "warnings": [...]}` (exits 1 on `valid: false`). With `--epic <id>`, `validate` doubles as the marker **arm** and is its SOLE null→timestamp writer: the create, defer, and close flows run it after wiring deps to flip a freshly-scaffolded epic's null `last_validated_at` to a timestamp (a fresh scaffold mints a not-ready ghost). The marker is an arm-exclusive one-way latch — no structural mutation verb ever writes it, and the only un-arm (timestamp→null) paths are `epic invalidate` and `refine-context --invalidate`. When the marker is still null, the runner manually invokes `auto_commit_from_invocation` (bypassing `emit()` to preserve the custom envelope shape) and merges the `plan_invocation` provenance into the single custom envelope — one JSON value on stdout, never a second document. Arming an already-armed epic is a no-op — only the one envelope prints (no commit).

## Planning Skills

These slash commands handle epic creation, refinement, single-task execution, the post-epic-close phase, and tier-1/2/3 followup audit:

| Command | When to use |
|---------|------------|
| `/plan <request>` | Any new feature — spawns scouts, runs gap-analyst, full outer-loop quality pass. Stamps the mechanical default `{tier, model}` cell at scaffold, then runs the post-scaffold selector beat to overwrite the cells before arming. Use for anything non-trivial. |
| `/plan:work <fn-N-slug.M>` | Drive a single claimed task to `done` by spawning the constant `work:worker` subagent — the launcher selects the tier-matched per-cell `work` plugin at launch via `--plugin-dir`, so `work:worker` resolves to it — and switching on `keeper plan reconcile`'s typed verdict. A content-blind orchestrator under hook-enforced no-commit constraints: it never edits, lints, or commits — every non-`done` verdict routes back into the worker as a resume directive, and the plugin's PreToolUse commit hard-deny blocks any commit attempt from the main context (bypassable per-session with `KEEPER_PLAN_GUARD_BYPASS=1`). |
| `/plan:defer <subject>` | The sole single-task scaffolder. Mainlines the actionable work in the conversation into a single-task epic at normal epic-number order — no priority jump — and stops on overrun rather than silently scaling up. Runs the same default-stamp plus selector beat over its single task before arming. Member of the `/plan:plan` family (not a job-launcher). Hand-written tracked skill. |
| `/plan:hack <request>` | Investigate a request, answer in the right shape, then route or execute the next move. Read-only by default — investigate, answer, stop; with plain-text greenlight it executes tight inline work, sketches a direction in chat, or funnels larger work to `/plan:plan` or `/plan:defer`. Slash-only (`disable-model-invocation: true`). Hand-authored static skill — no template, no `.managed-file-dont-edit` sidecar. |
| `/plan:panel <hard question>` | Fan a hard question out to two models (Opus 4.8 + GPT-5.5) answering in parallel and blind, then fuse their answers via the `plan:panel-judge` subagent with consensus, contradictions, and blind spots surfaced. Model-invokable for any non-tiny inquiry where being confidently wrong is expensive; `/plan:hack` routes to it before sketching above-inline work. Hand-authored static skill — no template, no `.managed-file-dont-edit` sidecar. |
| `/plan:prompt <prompt>` | Polish a raw prompt into a sharper one for the agent that will read it — a batched maturity loop toward a named rung (headline/blurb/note/memo/brief/spec), each turn recomputing a filled/total slot meter and making one clustered move (an approvable change-set, an `AskUserQuestion` batch, or an explore), with a constraint-polarity check on every rewrite; at first ready a Ship it / Keep polishing / Grow a rung fork. Read-only wrt the repo, clipboard-only export, nothing written to disk. Slash-only (`disable-model-invocation: true`). Hand-authored static skill — no template, no `.managed-file-dont-edit` sidecar. |
| `/plan:close <epic_id>` | After all tasks in an epic are done: a content-blind coordinator that runs `keeper plan close-preflight` → spawns `quality-auditor` blind (it persists its report via `audit submit`) → on findings, spawns `close-planner` blind (it vets/culls/merges and persists the verdict + follow-up plan via `verdict submit` / `followup submit`) → when survivors will scaffold a follow-up, interposes a content-blind pre-select beat (`keeper plan selection-brief --from-followup` → `plan:model-selector` blind → hands finalize a `--selection-verdict` file so the follow-up tasks are born with researched cells, degrading to a verdict-less finalize on any hitch) → `keeper plan close-finalize` and a total switch over its four typed `CloseOutcome` members. Every audit pipeline artifact lives on disk under `<primary_repo>/.keeper/state/audits/<epic_id>/`; the closer holds refs, hashes, counts, and one-line agent returns only, authoring just the small ordinal-keyed cell-selection verdict it hands finalize by path. The audit runs INLINE inside close before the irreversible close mutation — no `--audit-required` flag, no `auditor_done_at` stamp, no separate `/plan:audit` session. The planner's `fatal` flag is the only ship-block signal; `close-finalize` halts without closing on a fatal verdict (no status stamp — the absence of a close is the signal). `close-finalize` encodes the saga from observable state (stale-check, fatal-halt, reversible follow-up scaffold before the irreversible `epic close`) and is idempotent on re-run; the scaffold step stamps `epic.created_by_close_of: <source_eid>` onto the minted follow-up, and `close-finalize` discovers the follow-up by exact equality on that stamp — never by `depends_on_epics` membership. The follow-up still wires `depends_on_epics: [<source_eid>]` as a real dependency, but the dep edge is no longer the provenance signal, so a human-planned epic that legitimately depends on the source is never mistaken for the audit follow-up. Halts on a `QUESTION:` from the planner, stamping the question + its unstick sentence onto the epic via `keeper plan epic-question` (board-visible as a needs-human `keeper status` signal) and clearing it on the human's warm/cold resume; under autopilot a `QUESTION:` behaves like `BLOCKED` — the chain stops and the epic stays open. |
| `/plan:model-guidance [axis-value·missing·all]` | Author and refresh the post-scaffold selector's policy config (`model-selector.yaml`) — research each configured worker model, cache the raw signal under the skill's `references/`, distill it into the config's per-effort and per-model guidance blocks, and re-hash. Reads `model-guidance-check.ts --state` first and derives scope from the fail-closed per-value states in at most two questions: blank is the interactive fill-gaps / refresh-specific / wipe flow (wipe never the default, no model name ever typed), an axis value scopes to that one (loud failure on a non-axis name), `missing` fills every gap non-interactively, `all` wipes behind one confirm. Sole writer of `status: researched` — stamped only after a real research pass, else `stub`. Owns the content the drift gate checks; the select beats only read the config. Slash-only (`disable-model-invocation: true`). Hand-authored static skill. |

## Orchestrator hooks

The plugin ships three bun hook dispatchers under `hooks/` that keep the `/plan:work` and `/plan:close` orchestrators content-blind — all implementation work stays inside the worker subagent:

- **PreToolUse commit hard-deny** — denies `keeper commit-work` / `git commit` from the main context while the session's claimed task is in progress; worker-context commits (an `agent_id` is present) always pass.
- **SubagentStop worker guard** — a worker stopping in a non-`done`, non-`BLOCKED:` state gets exactly one corrective round.
- **Stop checklist guard** — a work-session Stop with a still-in-progress claimed task, or a close-session Stop where `close-finalize` never ran, blocks once with a resume checklist. The close branch blocks only when neither of its two zero-subprocess allow gates fires — a sanctioned typed-stop message, or an in-flight subagent the closer spawned and is awaiting (a `background_tasks` entry with `type:"subagent"` + `status:"running"`).

The work guard verifies live task state with a read-only `keeper plan reconcile` call before blocking; the close branch decides from the Stop payload alone (its typed-stop message and `background_tasks`), spawning no subprocess. All three fail open on any internal error. Session state is one JSON marker per session at `~/.local/state/keeper/sessions/<session_id>.json`. Set `KEEPER_PLAN_GUARD_BYPASS=1` to disable all three guards.

## Help for Agents

`keeper plan` includes hidden rich agent guidance:

```bash
keeper plan --agent-help
```

To orient on the board, reach for the keeper-native surfaces rather than hand-parsing plan verbs: `keeper status` for the board at a glance, and `keeper query tasks` for per-task detail (tier/model/title/deps + the live readiness verdict). Every `keeper plan` read still emits one clean JSON value, but the orient surfaces are purpose-built for it.

## License and Attribution

This project is MIT licensed (see [`LICENSE`](./LICENSE)).

The plan plugin is derived from [flowctl](https://github.com/gmickel/claude-marketplace) by Gordon Mickel. See [`NOTICES`](./NOTICES) for attribution and license details.
