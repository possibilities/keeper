# planctl

`planctl` is a file-based CLI for managing epics, tasks, dependencies, and markdown specs in structured software workflows.

- Data lives in `.planctl/` inside the project directory, under version control.
- Task runtime state is separated from task definitions.
- Spec changes are written in place to `specs/{id}.md`. Git provides the audit trail.
- Commands emit JSON by default. Pass `--format yaml` or `--format human` for alternate output. `cat` always emits raw markdown.

Data lives in `.planctl/` inside the project directory, under version control.

## Requirements

- Python `>=3.11,<3.14`
- [`uv`](https://docs.astral.sh/uv/) recommended for running/installing

## Install

From this repository:

```bash
uv sync
uv run planctl --help
```

Optional tool install:

```bash
uv tool install .
planctl --help
```

## Quick Start

```bash
# 1) Initialize current project
planctl init

# 2) Scaffold an epic + its tasks in one transactional call
#    (plan.yaml: epic mapping + ordered tasks list, deps as 1-based ordinals)
planctl scaffold --file plan.yaml

# 3) Refine an existing epic later (add tasks, rewrite specs/deps)
planctl refine-apply fn-1-add-auth --file delta.yaml

# 4) Work the task lifecycle (claim asserts + claims + writes the worker brief, returns a brief_ref)
planctl claim fn-1-add-auth.1
planctl done fn-1-add-auth.1 --summary "Chose JWT strategy"

# 5) Inspect state
planctl list
planctl validate
```

## Command Map

Top-level commands:

- `init`, `detect`, `status`, `validate`, `state-path`
- `claim`, `resolve-task`, `reconcile`, `done`, `block`, `ready`
- `show`, `epics`, `tasks`, `list`, `cat`
- `epic`, `task`, `dep`

`resolve-task <task_id>` (fn-593) — read-only routing lookup returning the subset of `claim`'s envelope an external consumer needs to pick a tier-plugin and police cwd. Retained as a public CLI surface; no longer wired to the `arthack-claude.py` launcher (keeper reads `task.tier` from its own projected Task data and launches with the matching `--plugin-dir` itself). Cwd-agnostic (scans configured `roots`); supports `--project <path>` to disambiguate. Returns `{task_id, epic_id, project_path, target_repo, primary_repo, tier, status}` — `tier` is one of `medium|high|xhigh|max` or `null`. No `.planctl/` write, no commit. Typed errors: `BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID | NOT_A_PROJECT`.

`reconcile <task_id>` (fn-6) — read-only post-worker verdict verb, the symmetric bookend to `claim`'s pre-worker brief handoff. Collapses the `/plan:work` orchestrator's post-worker reconciliation into one call returning a typed verdict the orchestrator switches on mechanically: `done | in_progress_committed | in_progress_uncommitted | blocked | state_uncommitted | not_started | tooling_error`. Computed entirely from planctl-native data — merged status, trailer-authentic source commits (against `target_repo` + `epic.touched_repos`), HEAD-visibility of the committed task JSON (against `state_repo`), and an epic-progress tally — with NO keeper dependency. Any git subprocess failure fails closed to `tooling_error`. Cwd-agnostic (scans configured `roots`); supports `--project <path>` to disambiguate. Returns `{verdict, task_id, epic_id, status, source_commits, state_head_visible, epic_progress, assessed_at, blocked_reason}`. No `.planctl/` write, no commit. Typed errors: `BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID`.

Subcommands:

- `epic`: `create`, `set-plan`, `set-branch`, `set-title`, `close`, `rm`, `add-dep`, `rm-dep`
- `task`: `create`, `set-description`, `set-acceptance`, `set-spec`, `reset`, `set-deps`
- `dep`: `add`
- `worker`: `resume`

## Storage Layout

All data lives in `.planctl/` inside the project directory:

```text
{project_root}/.planctl/
  meta.json
  epics/{epic-id}.json
  specs/{epic-id}.md
  specs/{task-id}.md
  tasks/{task-id}.json
  state/                    # gitignored -- ephemeral runtime data
    tasks/{task-id}.state.json    # task runtime status
    epics/{epic-id}.state.json    # epic runtime sidecar
    locks/{task-id}.lock
```

Specs are written in place to `specs/{id}.md` by commands that mutate spec content (`done`, `task set-description`, `task set-acceptance`, `task set-spec`, `task reset`, `epic set-plan`, `task create`, `epic create`). Git history provides the audit trail.

Environment variables:

- `PLANCTL_ACTOR` (override identity)
- `CLAUDE_CODE_SESSION_ID` (sole source of the session id used to key the touched-paths log under `.planctl/state/sessions/<session_id>/`; required for every mutating verb except `init`, the session-id-free verb that builds its own commit payload — the claude binary ships it intrinsically on every session including resumed ones, tests and manual invocations set it explicitly)

## Auto-commit

Every planctl CLI invocation emits a `planctl_invocation` NDJSON envelope on stdout. Mutating verbs additionally land a `chore(planctl): <op> <target>` commit inline at `output.emit()` via `planctl.commit.auto_commit_from_invocation` — the commit happens BEFORE the success envelope prints, so the envelope's appearance on stdout is the authoritative signal that the `.planctl/` commit landed. Read-only verbs (and runtime-only verbs like `claim`/`block`) emit the envelope but skip the git commit (`files` is empty → no-op). `claim` writes the worker brief to `<primary_repo>/.planctl/state/briefs/<task_id>.json` and returns a `brief_ref` handle, but that brief lives under gitignored `state/`, so it too lands no commit. On commit failure the runner prints a structured `{"success": false, "error": "commit_failed", "details": {...}}` envelope on stdout and exits 1 — the success envelope is NOT printed.

`init` is the session-id-free mutating verb: it builds its own commit payload directly (an explicit list of the bootstrap files it created), so it needs neither the touched-paths log nor `CLAUDE_CODE_SESSION_ID`. It lands a `chore(planctl): init <project-name>` commit with no `Session-Id:` trailer, but only when it wrote something AND the cwd is inside a git work tree — an idempotent re-run or an `init` in a non-git dir takes the read-only path with no commit.

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

For the full commit contract, see [`docs/reference/commit-at-mutation-boundary.md`](./docs/reference/commit-at-mutation-boundary.md).

## Version Control Advice

**Do not gitignore `.planctl/`.** Plan data is meant to be committed -- the `state/` subdirectory already has its own `.gitignore` for ephemeral runtime files (locks, active task state).

If you use a context-dump tool, add `.planctl/` to its ignore file so plan data doesn't flood your context.

## Output Contract

Commands emit JSON by default:

- Success: `{"success": true, ...}`
- Failure: `{"success": false, "error": "..."}`
- Non-JSON failures print `Error: ...` to stderr and exit non-zero.

Pass `--format yaml` for YAML output or `--format human` for human-readable text/tables.
`cat` always emits raw markdown regardless of `--format`.
`validate` uses a custom envelope: `{"valid": bool, "errors": [...], "warnings": [...]}` (exits 1 on `valid: false`). When `--epic <id>` is given and the epic has never been validated before, the runner manually invokes `planctl.commit.auto_commit_from_invocation` (bypassing `emit()` to preserve the custom envelope shape) and prints a second NDJSON document `{"planctl_invocation": {...}}` describing the marker write. Re-validating an already-stamped epic produces only the one-line envelope (no second document, no commit).

`planctl list` renders one row per epic with its title and status.

## Planning Skills

Four slash commands handle epic creation, refinement, the post-epic-close phase, and tier-1/2/3 followup audit:

| Command | When to use |
|---------|------------|
| `/plan <request>` | Any new feature — spawns scouts, runs gap-analyst, full outer-loop quality pass. Use for anything non-trivial. |
| `/plan:defer <subject>` | The sole single-task scaffolder. Mainlines the actionable work in the conversation into a single-task epic at normal epic-number order — no priority jump — and stops on overrun rather than silently scaling up. Member of the `/plan:plan` family (not a job-launcher). Hand-written tracked skill. |
| `/plan:next <epic_id>` | Flips board priority on an *existing* epic so it jumps to the front of the queue. Calls `planctl epic queue-jump`, which sets `queue_jump=true` and emits an envelope carrying `queue_jump: true` — keeperd folds it into the `epics.queue_jump` projection column and stamps a `!`-prefixed `sort_path` so the epic sorts above all other root epics on the board. Read-only short-circuit when already set. Does NOT scaffold. Hand-written tracked skill. |
| `/plan:close <epic_id>` | After all tasks in an epic are done: spawn `quality-auditor` → spawn `classifier` subagent (parses `<VERDICT_JSON>` block) → branch on `fatal` (off the in-memory verdict) → `planctl epic close <epic_id>` (stamps `closer_done_at`). **fn-559**: the audit runs INLINE inside close before the irreversible close mutation — no `--audit-required` / `--no-audit-required` flag, no `auditor_done_at` stamp, no separate `/plan:audit` session. `fatal` is the only ship-block signal; a closed epic is terminal (`closer_done_at` stamped) and completes the instant close lands. Halts without closing on fatal verdict or parse/schema failure (no status stamp — the absence of a close is the signal). The findings follow-up tree (when the inline audit produces one) is scaffolded as a normal epic — `epic.depends_on_epics: [<source_eid>]` carries the source-link, and the `scaffold` verb's inline auto-commit lands the tree. |

## Help for Agents

`planctl` includes hidden rich agent guidance:

```bash
planctl --agent-help
```

## License and Attribution

This project is MIT licensed (see [`LICENSE`](./LICENSE)).

`planctl` is derived from [flowctl](https://github.com/gmickel/claude-marketplace) by Gordon Mickel. See [`NOTICES`](./NOTICES) for attribution and license details.
