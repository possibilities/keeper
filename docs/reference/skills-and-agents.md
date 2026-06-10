# Skills and Agents

**Status:** Authoritative
**Applies to:** planctl CLI v1 / the `plan:*` plugin

This memo is the single source of truth for how planctl's `plan:*` skills and
worker/auditor agents are wired — which files are source vs. generated, how
tier routing reaches a worker, and the content-blind orchestration contract.
It defers to `docs/reference/commit-at-mutation-boundary.md` for every
envelope, auto-commit, `claim`, and `reconcile` mechanic instead of copying
it.

---

## 1. Skills: Source vs. Generated

`plan:*` skills live under `skills/`. Most — including `defer` and `next` —
are hand-written tracked source skills; only `/plan:work` is generated from a
template (`template/skills/work.md.tmpl`).

The four worker agents live in this plugin's own `agents/` directory as
generated, flat files — `agents/worker-{medium,high,xhigh,max}.md`, each
addressable `plan:worker-<tier>` — rendered per-variant from
`template/agents/worker.md.tmpl` by the `promptctl render-plugin-templates`
pass (the default agents branch emits `agents/<stem>-<variant>.md` per variant;
there is no `render_to:` directive and no per-tier plugin manifest). The files
MUST stay flat in `agents/`: a subfolder would fold into the scoped id
(yielding `plan:workers:worker-medium`). Each worker's `description`
frontmatter is narrowed to internal-only so the four in-scope tiers never
auto-delegate.

Every rendered worker agent gets a `<name>.managed-file-dont-edit` sidecar
carrying `{_warning, source_template, sha256}` that the `check-generated`
guard reads; both the rendered agents and the sidecars are gitignored — only
the template is source of truth (`agents/practice-scout.md` is the precedent).
The other agents the planctl plugin owns (`quality-auditor`, `close-planner`,
scouts, `gap-analyst`) stay in `agents/` too.

---

## 2. Tier Routing

A shared `worker_agent_for_tier(tier)` helper in `models.py` (beside
`TASK_TIERS`) maps `tier → "plan:worker-<tier>"` (and `None → None`); `claim`,
`worker resume`, and `resolve-task` each emit that string as a `worker_agent`
envelope field.

`/plan:work` is a pure pass-through: it spawns `Task(subagent_type=<worker_agent>)`
straight off the envelope at both warm and cold spawn sites (no bare
`work:worker` literal, no tier-picking at runtime, no `task set-tier` write),
and a null-tier task surfaces a clean typed stop at the spawn site rather than
a `plan:worker-None` crash. Keeper reads `task.tier` from its own projected
Task data for board/projection and launches workers with **no** `--plugin-dir`
flag — tier routing rides the emitted `worker_agent` name, not the launch line.

Operational note: `CLAUDE_CODE_SUBAGENT_MODEL`, if set in the launch env,
overrides every worker agent's `model` frontmatter and silently flattens all
four tiers to one model. The `arthack-claude.py` launcher is generic: it does
not call planctl, infer tiers, or recognize `/plan:*` prompt shapes.

---

## 3. Load-Bearing Invariants

### `/plan:close` is a content-blind coordinator

`/plan:close` coordinates the `quality-auditor` and `close-planner` agents
(advisory; no state mutations by the skill). The closer drives PROCESS only —
it speaks in typed envelopes and one-line agent returns and never holds the
audit report, the verdict JSON, or the follow-up plan. Every pipeline artifact
(audit brief, audit report, verdict, follow-up plan) persists as a file under
gitignored `<primary_repo>/.planctl/state/audits/<epic_id>/`, written by the
close-phase submit verbs at emission. The quality-auditor vets and persists
its report via `audit submit`; the close-planner absorbs vet/cull/merge +
follow-up authoring, persisting via `verdict submit` / `followup submit`.

`planctl close-finalize` encodes the saga in Python from observable state —
stale-check on `commit_set_hash`, fatal-halt, reversible follow-up scaffold
BEFORE the irreversible `epic close` — and returns one of four typed
`CloseOutcome` members (`closed_clean` / `closed_with_followup` /
`fatal_halt` / `partial_followup`) the skill switches on totally.
`close-finalize._find_followup_epic` discovers the follow-up by exact equality
on the `created_by_close_of` stamp the scaffold step writes onto the minted
epic (internal-only — stamped via `getattr(args, "created_by_close_of", None)`
in `run_scaffold`, never a CLI flag and never a `followup.yaml` key, so a
hand-authored plan cannot spoof provenance); it never scans
`depends_on_epics`, not even as a fallback, so a human-planned epic that
legitimately depends on the source is invisible to the closer. The field is
immutable after mint. The `actual_tasks == expected` count gate: a stamped hit
with too few tasks is `partial_followup`.

### Inheritor skills push spec assembly onto a brief-handoff verb

`/plan:work` and `/plan:close` push spec assembly onto a brief-handoff verb so
the skill never inlines prose. On the work path `planctl claim` assembles the
worker brief — task spec + epic spec — into
`<primary_repo>/.planctl/state/briefs/<task_id>.json` and returns a
`brief_ref`; `/plan:work` is content-blind and passes that handle to the
worker, which reads the brief itself. On the close path `planctl
close-preflight` writes the close-phase brief to
`<primary_repo>/.planctl/state/audits/<epic_id>/brief.json` (commit-free,
atomic) and returns `{brief_ref, commit_set_hash, primary_repo}` with no prose
fields; the quality-auditor and close-planner each read the brief by path. The
`claim` and `close-preflight` writes both land under gitignored `state/`, so
neither commits — see `commit-at-mutation-boundary.md` §3 for the
runtime-state-only verb contract.

### `/plan:close` runs the audit INLINE

The audit runs inside `/plan:close` before the irreversible `epic close` —
there is no standalone auditor session, no `auditor_done_at` stamp, no
`--audit-required` flag. The planner's `fatal` flag is the only ship-block
gate. `epic close` (fired by `close-finalize`) stamps `closer_done_at`, which
is the completion signal keeper folds — a closed epic is terminal and
completes the instant the stamp lands.

### `planctl resolve-task <task_id>`

`resolve-task` is a read-only routing-lookup verb that returns the subset of
`claim`'s envelope needed by an external launcher to route a worker and police
cwd: `{task_id, epic_id, project_path, target_repo, primary_repo, tier,
worker_agent, status}`. `worker_agent` is the `plan:worker-<tier>` name (via
`worker_agent_for_tier`, `null` for a null-tier task) a caller spawns directly.
Cwd-agnostic (scans configured `roots`, with `--project <path>` to
disambiguate). Field names overlap with `claim` so a caller has one parser.
Read-only — no `.planctl/` write, no commit; envelope carries the readonly
invocation footer with NULL `subject`/`files`. The `arthack-claude.py`
launcher is generic and does not call this verb; keeper reads `task.tier`
directly from its projected Task data for board/projection and launches
workers with no `--plugin-dir` flag. The verb is a public CLI surface for
other consumers.

### Content-blind orchestrator + `planctl worker resume`

`/plan:work` owns PROCESS only: it speaks in typed envelopes (ids, status,
shas, counts, categories) and never holds, reasons over, commits, or edits the
worker's content. Every form of incompleteness the post-worker `planctl
reconcile` switch surfaces — a non-`done` `in_progress_*` / `state_uncommitted`
verdict within the 5-attempt budget — routes to one primitive: resume the
worker with a minimal process nudge. The orchestrator never runs `planctl done`
and never commits source on the worker's behalf, and never acts on a
`tooling_error` verdict (it fails closed — surface and stop, never resume
against an unreliable verdict).

`planctl worker resume <task_id>` regenerates the brief fresh
(bake-fresh-on-each-entrypoint — no provenance hashes) and returns a typed
envelope `{task_id, status, tier, worker_agent, brief_ref, nudge, target_repo,
primary_repo, source_commit_sha?, dirty_session_file_count?}` — process facts
only, no narrative prompt and no `planctl cat` reference. `worker_agent` is the
`plan:worker-<tier>` name the orchestrator re-spawns on resume. The brief is a
regeneratable cache keyed off durable runtime state; a missing or corrupt brief
is re-minted by the next `claim` (ALREADY_MINE) or `worker resume`, never a
fatal inconsistency.

### `planctl reconcile <task_id>`

`reconcile` is the read-only post-worker verdict verb — the symmetric bookend
to `claim`'s pre-worker brief handoff. It collapses the `/plan:work`
orchestrator's post-worker reconciliation into ONE call returning a typed
verdict the orchestrator switches on mechanically. The verdict ∈ `done |
in_progress_committed | in_progress_uncommitted | blocked | state_uncommitted |
not_started | tooling_error`, computed entirely from planctl-native data —
merged status (`merge_task_state`), trailer-authentic source commits (`git log`
+ exact-match `Task:` trailer parse against `target_repo` +
`epic.touched_repos`), HEAD-visibility of the committed task JSON (`git
cat-file` against `state_repo`, unborn-branch-guarded), and an epic-progress
tally. NO keeper call (`dirty_session_files` attribution is rejected to keep
the one-way keeper→planctl edge — delivery cleanliness is the worker's job), no
`planctl show`, no shell-out to `planctl find-task-commit` (reconcile parses
the `Task:` trailer inline), no `keeper session-state`, no `validate --epic`,
no git-porcelain reasoning. Any git subprocess failure fails closed to
`tooling_error` (never silently `not_started`/`done`). Read-only — no
`.planctl/` write, no commit; envelope `{verdict, task_id, epic_id, status,
source_commits, state_head_visible, epic_progress, assessed_at,
blocked_reason}` carries the readonly invocation footer with NULL
`subject`/`files`. Cwd-agnostic (scans configured `roots`, `--project <path>`
to disambiguate); bad/missing/ambiguous id → typed error envelope (exit 1) like
`resolve-task` (`BAD_TASK_ID | TASK_NOT_FOUND | AMBIGUOUS_TASK_ID`). The
orchestrator's post-worker tail is this single call + a total switch on the
seven verdicts — there is no separate orchestrator test phase, and the worker
reaches `done` only via a passing-test commit (commit-before-done) and
self-checks its own delivery cleanliness before returning. See
`commit-at-mutation-boundary.md` §9 for the commit-then-done worker contract
and the harness-drop recovery verdicts.

### Cross-project epic deps

Cross-project epic deps depend on the same configured `roots`.
`epic.depends_on_epics` entries are bare `fn-N` ids (epic ids are globally
unique via `_find_foreign_owner`) and resolve cwd-first-then-global through
`planctl.discovery.resolve_epic_globally`. Without `roots`, single-repo
workflows still work unchanged via the cwd short-circuit; cross-project
resolution simply doesn't activate. The readiness gate distinguishes
`blocked_pending` (dep resolved, not yet runtime-complete) from
`blocked_dangling` (dep resolved nowhere), and the write-side surfaces
`dep_ambiguous_id` instead of silently picking when a legacy dup exists. Full
contract: `docs/reference/cross-project-epic-deps.md`.

### `/plan:defer` and `/plan:next`

`/plan:defer <subject>` and `/plan:next <epic_id>` split single-task scaffold
and priority-flip into two hand-written tracked source skills (`name: defer`,
`name: next`) — neither is template-generated. `/plan:defer` is the sole
single-task scaffolder: it mainlines the actionable conversation work into a
single-task epic at normal epic-number order and stops on overrun (offering a
concrete alternative, never silently scaling up). `/plan:next` operates on an
*existing* epic — it does NOT scaffold — and flips board priority by calling
`planctl epic queue-jump <epic_id>`, a conditionally-mutating epic verb with a
read-only short-circuit when already set. `queue-jump` sets `queue_jump=true`
and emits an envelope carrying `queue_jump: true`; keeperd's reducer derives
`queue_jump` (sticky-true) from any event carrying that signal and stamps a
`!`-prefixed `sort_path` so the epic sorts above all other root epics on the
board. Both skills are members of the `/plan:plan` family — NOT job-launchers,
no worker spawn, no audit, no `_ROLE_SKILL_NAMES` entry, no `<role>::<id>`
session-naming prefix.
