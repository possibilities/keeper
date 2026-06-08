# Commit at the Mutation Boundary

**Status:** Authoritative
**Applies to:** planctl CLI v1 (fn-587 and later)

This memo is the single source of truth for planctl's commit contract. All
other docs that describe commit behavior defer to this file.

Every mutating planctl verb commits its own `.planctl/` scope inline at
the verb boundary. There is no `commit-plan` verb, no skill-seam table,
no deferral mechanism, no skill cooperation needed. The runner-side
`output.emit()` call lands the `chore(planctl): <op> <target>` git
commit — scoped to its own exact paths via `git commit -F - -- <files>`,
with a bounded retry over git's own lock domains — then prints the
`success: true` envelope. An envelope on stdout means the commit landed.

---

## 1. Per-Verb Auto-Commit Principle

Every planctl verb that mutates `.planctl/` carries its own commit. The
verb knows mechanically which files it touched, derives a deterministic
subject from its `op` and `target`, stages its exact pathspec, commits.
No agent-authored commit messages. No outer skill coordination. No "what
landed since last time" audit-table scan.

The model is fail-safe at the verb: any path that emits a
`planctl_invocation` envelope commits its own scope, including a verb
fired outside a `/plan:*` skill — notably `approve` from a human-typed
CLI.

---

## 2. Per-Verb Mechanics

For every mutating verb invocation:

1. **Build `planctl_invocation` payload** — `planctl.invocation.build_planctl_invocation`
   reads the session touched-paths log and intersects it with `git status
   --porcelain --untracked-files=all -- .planctl/` to produce `files`
   (touched ∩ dirty). It also fills `op`, `target`, `subject`
   (`chore(planctl): <op> <target>` via `commit_messages.build_subject`),
   `repo_root`, and `state_repo`.
2. **Auto-commit** — `output.emit()` calls
   `commit.auto_commit_from_invocation(payload)`. The helper runs a
   stage → commit sequence under a bounded full-jitter retry over git's
   own lock domains (see §7). Each attempt:
   - No-ops when `files` is `None`/`[]` (read-only verb, runtime-only
     verb, or no dirty intersection).
   - Resolves the cwd from `payload['state_repo']` (with a stderr-noisy
     fallback to `payload['repo_root']`).
   - Re-confirms dirtiness via
     `git diff --cached --quiet -- <files>` ∪ `git diff --quiet -- <files>`;
     returns `None` if a concurrent verb already swept the files.
   - Re-reads `HEAD` SHA as `Planctl-Prev-Op` (inside the retried body, so
     a ref-lock loser re-parents off the winner's tip).
   - Stages with `git add -- <files>` (explicit pathspecs only — never
     `-A`, never `.`).
   - Commits with `git commit -F - -- <files>` piping the message on
     stdin and scoping the commit to its own exact paths.
3. **Print success envelope** — `output.emit()` prints the success
   envelope as compact single-line JSON (NDJSON). The envelope's
   appearance on stdout is the authoritative signal that the commit
   landed.

Subject shape (verbatim from `commit_messages.build_subject`):

```
chore(planctl): <op> <target>
```

Trailers (always present on auto-commit commits):

```
Planctl-Op: <op>
Planctl-Target: <target>
Planctl-Prev-Op: <full sha of HEAD before this commit>
```

`Planctl-Prev-Op` seeds a cheap undo substrate:
`git diff <prev-op>..HEAD -- .planctl/` shows exactly what the verb
changed.

---

## 3. Verb-Runner Self-Emit + Auto-Commit

Every planctl CLI verb emits a `planctl_invocation` NDJSON envelope on
stdout. Mutating verbs additionally land a git commit inline from
`output.emit()` — there is no PostToolUse hook anymore. keeper reads the
envelope off `PostToolUse:Bash` stdout; planctl writes no SQLite audit
trail.

### Envelope shape

```json
{"success": true, "planctl_invocation": {"op": "done", "target": "fn-7-add-auth.2", "subject": "chore(planctl): done fn-7-add-auth.2", "files": [".planctl/tasks/fn-7-add-auth.2.json", ".planctl/specs/fn-7-add-auth.2.md"], "touched_path_files": [".planctl/state/sessions/<sid>/touched/<uuid>.txt"], "repo_root": "/path/to/worker/repo", "state_repo": "/path/to/primary/repo", "queue_jump": false}}
```

Per §4, an envelope `success: true` confirms the git commit landed.

`queue_jump` (optional, bool, default `false`) rides envelopes from
two verbs. `scaffold` carries it on a `/plan:defer`-class mint that
opts in; `epic queue-jump` (the verb behind `/plan:next`) carries it
on an *existing* epic to flip board priority post-hoc. It is the
server-derived signal keeperd folds into the `epics.queue_jump`
projection column (schema v30) to drive the `!`-prefix `sort_path`
branch in `cascadeSortPath` — the reducer derives it sticky-true from
any event carrying the signal, so a `queue-jump` envelope on an epic id
that already has committed events projects the `!`-prefixed sort path
without a keeper change. Old envelopes lacking the key fold to `false`
per the standard `?? false` lift, preserving re-fold determinism.

**`repo_root` vs `state_repo`** — two distinct fields, always present:

- `repo_root` — the cwd-derived repo at invocation time.
- `state_repo` — the repo whose `.planctl/` directory holds the state
  for this epic/task. Populated from `epic.primary_repo` for verbs
  targeting an epic/task; falls back to `repo_root` for verbs with no
  target (e.g. `init`, `detect`). Used by `auto_commit_from_invocation`
  to route the commit.

For single-repo projects these two fields are always equal. Multi-repo
routing happens inside `auto_commit_from_invocation` — the destination
is resolved from `state_repo`, not from the cwd of the agent that fired
the verb.

### Verb classification

`output.emit()` owns the build→commit path for every mutating verb routed
through the seam: it builds the `planctl_invocation` payload itself (the
build is INSIDE emit), then invokes `auto_commit_from_invocation`. Callers
pass `verb=`, `target=`, and `repo_root=`. There is no seam-level write-tree
unwind: on a pre-commit raise (invocation-build failure or a git
status/add/commit error) the verb's written files stay on disk (§10
no-rollback), and the
keeper HEAD-gate keeps an uncommitted tree invisible to the autopilot until
it reaches HEAD. The three multi-file mint verbs (`scaffold`,
`refine-apply`, `epic create`) keep their own LOCAL write-phase try/except
blocks that unwind a MID-WRITE crash (single-writer atomicity); those blocks
do not cover the commit-failure window. There is no commit flock — the
commit is scoped to its own exact paths via `git commit -F - -- <files>` and
a bounded retry absorbs git's index/ref lock contention (§7).
`_epic_id_lock` (the sub-millisecond id-allocation lock in `run_epic_create`)
is released before the auto-commit runs; it stays off the git-commit
critical path.

`init` is the one mutating verb that builds its own `planctl_invocation`
payload directly and hands it to `emit(planctl_invocation=...)` — it does NOT
route through the `verb=` build path, so it never calls
`build_planctl_invocation` and carries no session-id requirement (§12). `init`
writes a fixed, known bootstrap set (`.planctl/meta.json`,
`.planctl/.gitignore`, `.planctl/CLAUDE.md`, the `.planctl/AGENTS.md` symlink),
so the payload's `files` is the explicit list of paths it created this
invocation — no touched-paths-log discovery needed. The payload omits the
`session_id` key, so the resulting commit carries no `Session-Id:` trailer
(§5). `init` self-commits only when it wrote at least one file AND the cwd is
inside a git work tree; an idempotent re-run that writes nothing, or an `init`
in a non-git dir, takes the read-only `emit()` path and lands no commit.

| Class | Envelope | Auto-commit | Pre-commit-raise behavior |
|---|---|---|---|
| Mutating, single-field (`done`, `approve`, `epic close`, `epic invalidate`, `epic add-dep`/`add-deps`/`rm-dep`, every `epic set-*` / `task set-*`, `task reset`, ...) | non-null `subject`, populated `files` | yes (inline) | every write is a rewrite of a pre-existing tracked file via atomic_write rename-atomic; prior valid contents stay in place |
| Mutating, whole-tree (`scaffold`, `refine-apply`, `epic create`) | non-null `subject`, `files` covers the full epic+tasks+specs+deps tree | yes (inline, one commit) | the LOCAL write-phase block unwinds a mid-write crash; a pre-commit raise from the seam leaves the fully-written tree on disk (§10), invisible to the autopilot via the keeper HEAD-gate |
| Mutating, whole-tree delete (`epic rm`, fn-623) | non-null `subject`, `files` lists every unlinked path (epic JSON, every task JSON, epic + task specs, runtime state, locks) — paths are recorded BEFORE the unlink so the `touched ∩ dirty` pathspec captures the deletions | yes (inline, one commit) | the verb is a delete — a pre-commit raise leaves the deletes in place (§10), nothing to re-create |
| Mutating, self-built payload (`init`) | non-null `subject`, `files` is the explicit bootstrap set it created; NO `session_id` key (no `Session-Id:` trailer) | yes (inline, via `emit(planctl_invocation=...)`), only when something was written AND inside a git work tree | the writes are fresh files; a pre-commit raise leaves them on disk (§10), and an idempotent re-run is the read-only `emit()` path |
| Runtime-state-only (`claim`, `block`) | `subject=null`, `files=null` | none (gitignored state) | n/a |
| Read-only (`show`, `cat`, `list`, ...) | `subject=null`, `files=null` (via decorator) | none | n/a |
| `validate --epic <id>` (first-ever valid) | non-null `subject`, single file | yes (manual `auto_commit_from_invocation` call from the validate runner, which bypasses `emit()` to preserve its `{valid, errors, warnings}` envelope shape) | bypass — documented out-of-scope per §13's `validate --epic` row, see the asymmetry note below |
| `refine-context --invalidate` (conditionally-mutating) | non-null `subject`, single file | yes (inline) | envelope shape is `emit()`-compatible; the single-field rewrite is a rename-atomic over a pre-existing tracked file, so prior valid contents stay in place |

`scaffold` is one mutating invocation that spans many `atomic_write` calls but
emits exactly **one** envelope and produces one git commit covering every
written path. `refine-apply` is its sibling on an existing epic: its Phase 4.5
re-write rides inside the same flow, and its LOCAL write-phase blocks unwind a
mid-write crash on the freshly-minted task/spec tree the same way scaffold's
does.

**keeper-side observation gate (the SOLE pre-commit guard).** keeper's
plan-worker producer (the file watcher folding `.planctl/{epics,tasks}/*.json`
into the `epics` projection) gates snapshot emission on a synchronous
`git cat-file -e HEAD:<relpath>` check — until the file is in HEAD, no
`EpicSnapshot`/`TaskSnapshot` is emitted and the autopilot cannot
dispatch against it. This HEAD-gate is the single guard that closes the
fn-627 duplicate-dispatch window: an uncommitted epic tree on disk (a tree
that persisted past a hard `commit_failed`, or a fresh in-flight pre-commit
tree) is simply never observed. planctl carries no complementary
seam unwind or orphan reaper — an untracked tree is harmless because it
is invisible, and the next mutating verb whose `touched ∩ dirty` intersects
it sweeps it into a commit. See `~/code/keeper/CLAUDE.md` § Autopilot
dispatch gates and `~/code/keeper/README.md` § Architecture (the **fourth**
Worker thread) for the keeper-side detail; for planctl's commit
contract, every seam-routed verb's success envelope on stdout means the
file is in HEAD and observable.

---

## 4. Failure Modes

Auto-commit failure is a **hard error** — no success envelope, structured
failure envelope on stdout, exit 1.

When `commit.auto_commit_from_invocation` raises `CommitFailed`,
`output.emit()` prints:

```json
{"success": false, "error": "commit_failed", "details": {"error": "<class>", "message": "<verbatim stderr>", ...}, "planctl_invocation": {...}}
```

The `details.error` codes are:

| Code | Meaning |
|---|---|
| `commit_contended` | git index/ref lock contention persisted across the bounded retry (see §7). |
| `git_status` | `git status` / `git diff` plumbing call failed. |
| `git_add` | `git add -- <files>` failed (e.g. pathspec error, permission). |
| `git_commit` | `git commit -F - -- <files>` failed (hook rejected, gpg failed, etc.). |
| `missing_state_repo` | Payload lacked both `state_repo` and `repo_root` — envelope-shape drift. |
| `missing_subject` | Payload lacked a `subject` — envelope-shape drift. |

**Pre-commit failure leaves writes on disk (§10 no-rollback).** There is
no seam-level write-tree unwind. On a pre-commit raise — invocation-build failure
(e.g. missing `CLAUDE_CODE_SESSION_ID`) or a git status/add/commit error —
the verb's written files stay on disk and the failure envelope lands on
stdout with exit 1. For the multi-file mint verbs (`scaffold`,
`refine-apply`, `epic create`), a MID-WRITE crash is still unwound by
their LOCAL write-phase try/except block (single-writer atomicity); the
commit-failure window is NOT covered, so a fully-written tree persists.
For the single-field verbs (`done`, `approve`, every `set-*`, etc.) each
write is a rename-atomic rewrite of a pre-existing tracked file — the
prior valid contents stay in place. An uncommitted tree is harmless: the
keeper HEAD-gate (§3) never observes it, so the autopilot never dispatches
against it.

**Post-commit failure persists on disk.** Once `git commit` returns
success, files are tracked in HEAD — no rollback is attempted, ever
(§10 no-rollback policy).

**`validate --epic` (the seam-bypass verb)** is the same
write-persists-on-failure shape: the runner calls
`auto_commit_from_invocation` directly to preserve its `{valid,
errors, warnings}` envelope shape, so its single-field
`atomic_write_json` (`last_validated_at` stamp) lands BEFORE the commit
and persists on disk on a commit failure. See §13's "validate --epic
stamp-then-commit asymmetry" sub-section for the full reconcile path —
the dirty file is swept into the next mutating verb's auto-commit.

Reconcile path for any shape: re-run the verb (idempotent for most
stamping verbs) or `git checkout -- .planctl/` (and remove any untracked
files with `git clean -- .planctl/`) to discard persisted state. An
uncommitted epic tree that survived a hard `commit_failed` is invisible to
the autopilot via the keeper HEAD-gate; the next mutating verb whose
`touched ∩ dirty` intersects it sweeps it into a commit.

---

## 5. Subject and Trailer Format

### Commit subject

```
chore(planctl): <op> <target>
```

`<op>` is the verb's audit op (`done`, `approve`, `scaffold`,
`refine-apply`, `epic-invalidate`, ...). `<target>` is the entity id
the verb scoped to.

Examples:

```
chore(planctl): done fn-7-add-auth.2
chore(planctl): approve fn-7-add-auth
chore(planctl): scaffold fn-7-add-auth
chore(planctl): refine-apply fn-7-add-auth
chore(planctl): init <project-name>
```

For `init` the `<target>` is the project name (the repo root directory name),
not an `fn-` id — it mints no epic. The `init` commit carries the
`Planctl-Op` / `Planctl-Target` / `Planctl-Prev-Op` trailers but no
`Session-Id:` trailer: `init` builds its own payload without a `session_id`
key (§12).

### Trailers

```
Planctl-Op: <op>
Planctl-Target: <target>
Planctl-Prev-Op: <full sha of HEAD before this commit>
```

`Planctl-Prev-Op` seeds the cheap undo substrate:
`git diff <prev-op>..HEAD -- .planctl/` shows exactly what the verb
changed.

---

## 6. Source-Code Commits: `keeper commit-work`

Source-code commits are not auto-commit territory. Workers commit via
`keeper commit-work`:

```bash
keeper commit-work --preview-files
keeper commit-work "feat(scope): add the feature

Task: fn-7-add-auth.2"
```

`keeper commit-work` uses its own flock at
`$GIT_COMMON_DIR/keeper-commit-work.lock` (an `flock(2)` whose fd is
`FD_CLOEXEC`, so spawned children never inherit or hold the lock).
Planctl's `auto_commit_from_invocation` takes NO flock — it scopes each
commit to its own exact paths via `git commit -F - -- <files>` and
absorbs git's index/ref lock contention with a bounded retry (§7). The
two paths are independent: keeper source commits and planctl `.planctl/`
auto-commits target disjoint pathspecs, so they never cross-contaminate
on the same host even when racing the shared index.

### Push semantics

`keeper commit-work` **always pushes** to origin after a successful
commit — no `--no-push` flag, no CLI-side retry, no rollback of the
commit on push failure. The CLI emits two compact NDJSON envelopes:

1. **Commit envelope**: `{"success": true, "commit_sha": "<sha>", "files": [...]}`
2. **Push envelope (success)**: `{"success": true, "pushed": true, "remote": "origin", "branch": "<branch>"}`

On push failure the second envelope becomes
`{"success": false, "pushed": false, "push_error_class": "<class>", "push_error": "<verbatim stderr>"}`
and the CLI exits 1. `push_error_class` is one of:

| Class | Meaning |
|---|---|
| `non_fast_forward` | Remote has commits the local doesn't have; rebase or pull before retrying. |
| `auth` | Credential/permission failure on push. |
| `hook_rejected` | Remote pre-receive hook declined the push. |
| `no_upstream` | Branch has no upstream configured (normally handled by `_ensure_pushable`). |
| `network` | DNS / connectivity failure talking to the remote. |
| `other` | Anything unmatched — inspect `push_error` stderr. |

Planctl auto-commits do **not** push. State commits piggyback on the
next `commit-work` push (or whatever next pushes origin/HEAD). This
keeps deploy triggers aligned with source changes rather than every
state mutation.

### Push-failure resolution contract

Workers return `BLOCKED: TOOLING_FAILURE` carrying the verbatim
`push_error` stderr; the human resolves (rebase/pull/auth fix). The
intra-host flock kills the same-host race; cross-host races remain
possible and the human resolves them.

### Scoped lint policy

`keeper commit-work` runs the lint matrix inside the flock against the
session-scoped file set, shelling the cwd-discovered external linters —
**ruff check** + **ruff format --check** + **ty** + **cli-boundaries**
(project-wide when any `.py` is staged), per-extension **shellcheck** /
**zig** / **lua** / **hadolint**, **npm lint** per JS/TS package, plus a
dedicated **`tsc --noEmit --project`** arm. Exit code is the sole
pass/fail signal; stderr is captured verbatim.

Every applicable arm runs before raising. On any failure the CLI emits
`{"success": false, "error": "lint_failed", "linter": "<which>", "files": [...], "stderr": "<verbatim>"}`
(`"linter": "multiple"` with aggregated stderr when more than one arm
fails) and exits 1.

---

## 7. Pathspec-Scoped Commit + Bounded Retry (no flock)

Planctl's `auto_commit_from_invocation` takes NO flock. Each commit is
scoped to its own exact paths via `git commit -F - -- <files>`, so two
same-repo verbs sharing one index never cross-contaminate — the loser's
staged files never leak into the winner's commit. The committed surface is
conflict-free by construction: per-epic-namespaced files, gitignored runtime
state, exact-name `git add`. `keeper commit-work` keeps its own independent
flock at `$GIT_COMMON_DIR/keeper-commit-work.lock` for its stage → lint →
commit → push window; that flock is untouched by this change.

Two git lock domains can transiently lose a same-host race:

- **Index lock** (`.git/index.lock`) — a concurrent `git add` / `git
  commit` holds it; the loser's stage step fails. Retryable in place.
- **Ref lock** (`.git/refs/.../HEAD.lock`) — a concurrent commit holds it;
  the loser writes a dangling commit unless it re-parents. The retry MUST
  re-run the full `add` + `commit` from the current HEAD so the loser
  re-parents off the winner's tip.

Both domains are absorbed by a bounded full-jitter retry:

- **Attempts**: 8 (`_RETRY_MAX_ATTEMPTS`).
- **Backoff**: full jitter, exponential base, capped at 2 seconds
  (`_RETRY_CAP_SECONDS`).
- **Re-run body**: each attempt re-confirms dirtiness, re-reads HEAD (so
  `Planctl-Prev-Op` reflects the FINAL parent), re-stages, re-commits.
- **Retry trigger**: ONLY contention stderr (index.lock / ref-lock). A
  genuine failure (hook reject, signing, empty tree, real add/status error)
  surfaces immediately, never masked by a retry.
- **Exhaustion**: raises `CommitFailed("commit_contended", ...)`.

Disjoint pathspec-scoped files need no merge, so a ref-lock re-parent off
the winner's HEAD is always safe. Cross-host races are not covered by the
retry; the human resolves any cross-host `non_fast_forward`.

---

## 8. Ack Stamps Live in `.planctl/state/acks.db`

`planctl task ack` and `planctl epic ack` write `worker_acked_at` /
`closer_acked_at` into a **gitignored** SQLite WAL at
`.planctl/state/acks.db` — NOT onto the tracked task/epic JSON.

### Why

Ack stamps fire from contexts that do not always commit cleanly (direct
CLI). Storing them off the tracked JSON keeps the auto-commit path
silent on ack — `files=[]` → no-op — and eliminates a whole class of
rescue commits that the pre-fn-488 hook model produced. No commit needs
to cover acks because acks are not in git.

### Consumer derivation

Consumers (keeperd, keeper readers) read `.planctl/state/acks.db` and
merge the `worker_acked_at` / `closer_acked_at` values into their
task/epic projections. The storage shape is the contract; the on-disk
layout is implementation detail.

### `planctl task reset` semantics

`planctl task reset` clears both `worker_done_at` (on tracked JSON,
lands via auto-commit) and `worker_acked_at` (in `acks.db`, gitignored).
No commit covers the ack clear.

---

## 9. Worker Contract: Commit-Then-Done

Each completed task produces exactly two commits, in this order:

1. **`feat(<scope>): <summary>`** (carrying `Task: <task_id>` trailer) —
   the worker's `keeper commit-work "<msg>"` commits source code and
   tests. Auto-pushed to origin.

2. **`chore(planctl): done <task_id>`** — landed inline by `planctl
   done <task_id>` via `output.emit()` → `auto_commit_from_invocation`.
   Commits `.planctl/` state (spec patches, evidence, `worker_done_at`
   stamp).

Source-before-state matches confidence: source is "here's the work,"
state is "…and it's accepted." The worker fires `planctl done` as its
last act; the state commit lands as a side effect.

### Recovery property

A harness drop can land at three places under this contract:

- **Drop before source commit (mid-implementation):** task
  `in_progress`, source uncommitted. `keeper session-state` shows dirty
  `session_files`. Warm SendMessage resume asks the resumed worker to
  finish + commit + done. Cold spawn takes the HARNESS_DROPPED carve
  and continues from Phase 3.
- **Drop between source commit and `planctl done` (source committed,
  not done):** task `in_progress`, `keeper find-task-commit $TASK_ID`
  returns the trailer commit. Resume / fresh worker skips to `planctl
  done`; the state commit lands inline as the verb fires.
- **Drop after `planctl done` (both commits in place):** task `done`,
  both commits in history. Parent loses only the worker's free-text
  return summary.

The recovery budget is **5 attempts (1 spawn + 4 retries)** — each warm
SendMessage resume and each cold fresh-respawn counts one attempt toward
the budget; `RESUME_EXHAUSTED` fires only after the 5th attempt drops.
The budget is tracked **best-effort per-invocation** (warm path holds an
in-memory counter; cold path has no shared cross-invocation counter — a
separate `/plan:work` run that opens with the task already `in_progress`
gets its own fresh budget). No attempt-count field is persisted on the
task.

The orphan layer is always one of {source uncommitted, source committed
but no done stamp} — both loud (`git status`, `planctl show`).

---

## 10. Commit-Failure Policy

Auto-commit failure is a **hard error** (the Option C contract). See
§4 for the failure-envelope shape and `details.error` codes.

- The verb does NOT print a success envelope.
- The verb prints a structured failure envelope on stdout and exits 1.
- **Pre-commit: writes persist** (no seam unwind).
  For the multi-file mint verbs (`scaffold`, `refine-apply`, `epic
  create`), a MID-WRITE crash is still unwound by their LOCAL
  write-phase try/except block; a pre-commit raise after the write phase
  completed leaves the fully-written tree on disk. For the single-field
  verbs (`done`, `approve`, every `set-*`, etc.), each write is a
  rename-atomic rewrite of a pre-existing tracked file, so prior valid
  contents stay in place. For `epic rm` the deletes already landed and
  stay deleted.
- **Post-commit, no rollback**: once `git commit` returns success,
  files are tracked in HEAD; the seam never unlinks them. No partial
  rollback is attempted. Build-forward: fail visibly, let the human
  reconcile.
- **`validate --epic` bypass** is the same write-persists-on-failure
  shape (§4 + §13).

An uncommitted epic tree that persists past a hard `commit_failed` is
**harmless**: keeper's plan-worker observation gate (§3) gates snapshot
emission on `git cat-file -e HEAD:<relpath>`, so the autopilot never
observes — and never dispatches against — a tree that is not yet in HEAD.
That HEAD-gate is the SOLE guard against the fn-627 duplicate-dispatch
window; planctl carries no seam unwind or orphan reaper. The
next mutating verb whose `touched ∩ dirty` intersects the dirty file
sweeps it into a commit.

Reconcile path:

```bash
# Option A — rerun the verb (idempotent for stamping verbs)
planctl done fn-7-add-auth.2 --summary "..."

# Option B — discard the writes
git checkout -- .planctl/      # tracked-file rewrites
git clean -- .planctl/         # untracked mint trees
```

---

## 11. Security Boundary

### Path-traversal guard in `_read_touched_paths`

`invocation.py::_read_touched_paths` validates each path it reads from
the touched-paths log before returning it to `build_planctl_invocation`:

- Rejects any path whose components contain `..` (directory traversal).
- Rejects any path that does not start with `.planctl/`.

Both checks raise `RuntimeError` with a descriptive message — no silent
drop.

### Pathspec confinement in auto-commit

`auto_commit_from_invocation` stages only the paths in
`payload['files']` — which is itself the intersection of the touched
log (already `.planctl/`-rooted per the guard above) with the dirty
set. There is no `--files` flag, no `-A`, no `.`; the verb cannot stage
a non-`.planctl/` file.

### Porcelain subprocess (no GitPython/pygit2)

Auto-commit shells out to porcelain `git` via `subprocess`. This
ensures `commit.gpgSign`, `pre-commit` hooks, and `core.hooksPath` are
all respected — library calls (GitPython, pygit2) bypass hooks and
signing silently.

---

## 12. Concurrent-Session Safety

### Per-session touched-paths recorder

Every successful `atomic_write` / `atomic_write_json` in
`planctl/store.py` appends the written path to a lock-free per-session
directory:

```
.planctl/state/sessions/<session_id>/touched/<uuid>.txt
```

One path per file — concurrent verbs in the same session never contend,
and no `fcntl` dance is needed. Any verb that moves files via
`shutil.move` (which bypasses `atomic_write`) must call `_record_touched()`
explicitly after each move.

At envelope-build time, `build_planctl_invocation`:

1. Reads all touched-path records for the session via
   `_read_touched_paths` (path validation happens here — see §11).
2. Calls `_dirty_planctl_paths` (`git status --porcelain
   --untracked-files=all -- .planctl/`) to get the current dirty set.
3. Intersects the two sets — only paths that are both touched and dirty
   appear in `files`.

`auto_commit_from_invocation` re-intersects on each retry attempt to
handle the race where a concurrent verb already swept the files between
payload-build and commit. Pathspec-scoped commits mean even a lost race
never cross-contaminates: the loser re-confirms clean and no-ops, or
re-parents off the winner's HEAD and commits its own disjoint paths.

### Fail-closed on None session id

`invocation.py::build_planctl_invocation` resolves the session id from
the `CLAUDE_CODE_SESSION_ID` env var — the sole source. The claude
binary ships this intrinsically on every session including resumed ones;
tests and manual invocations set it explicitly.

If `CLAUDE_CODE_SESSION_ID` is unset / empty, `build_planctl_invocation`
raises `RuntimeError` naming the env var — no process-tree walk, no
wildcard fallback.

`init` is the one mutating verb exempt from this requirement: it builds its
own `planctl_invocation` payload directly (an explicit fixed file list of the
bootstrap set it created) and hands it to `emit(planctl_invocation=...)`,
never calling `build_planctl_invocation`. The session id is only needed by
variable-file verbs that discover their commit set through the touched-paths
log; `init` writes a known set, so it needs neither the log nor the env var.
Its payload omits the `session_id` key, so the commit lands with no
`Session-Id:` trailer (§5), and `init` runs identically whether or not
`CLAUDE_CODE_SESSION_ID` is set.

---

## 13. Testing Patterns

### Fixture pattern

```python
@pytest.fixture
def git_repo(tmp_path):
    subprocess.run(["git", "init"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "core.hooksPath", "/dev/null"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    return tmp_path
```

Per-test `tmp_path` + `git init` + `commit.gpgsign=false` +
`core.hooksPath=/dev/null` is the convergent pattern.

### What to test

| Scenario | What to assert |
|---|---|
| Verb runner self-emit | Envelope emitted on stdout |
| Mutating-verb auto-commit happy path | One `chore(planctl): <op> <target>` commit landed; subject + trailers correct |
| Auto-commit no-op (clean) | `auto_commit_from_invocation` returns `None`; no commit; success envelope still prints |
| Auto-commit failure | No success envelope on stdout; failure envelope with `error: commit_failed` and `details.error` ∈ {`commit_contended`, `git_*`, `missing_*`}; exit 1 |
| Commit contention retry | Index/ref-lock contention stderr triggers the bounded retry (re-run add+commit from current HEAD); a ref-lock loser re-parents off the winner's tip; exhaustion raises `CommitFailed("commit_contended", ...)`; a genuine failure (hook reject, empty tree) surfaces immediately with NO retry |
| Concurrent-sweep race | Verb A commits the files; Verb B re-confirms clean files and returns `None` (no empty commit); pathspec-scoped commits never cross-contaminate |
| `done` verb | `chore(planctl): done <task_id>` commit lands in one verb call |
| `task ack` | Writes `acks.db` only; no commit; envelope carries `subject=null`/`files=null` |
| `approve` (paradigmatic any-cwd case) | Verb fires from any cwd (no `/plan:*` skill) — commit still lands |
| `scaffold` whole-tree | One commit covers epic + tasks + specs + deps; envelope `files` lists every written path |
| `scaffold` integrity-gate failure (fn-623) | `scan_max_epic_id` unchanged; zero orphan `specs/fn-N-*.md` on disk (in-memory `epic_spec_content=` pass means no spec lands before the gate); failure envelope only, no commit |
| Seam pre-commit persistence (fn-640) | Multi-file mint verb raises AFTER the write phase (invocation-build raise or simulated `git` failure); the fully-written tree PERSISTS on disk (no seam unwind); the failure envelope lands; `_epic_id_lock` releases before the git commit runs (no nesting regression) |
| Local write-phase unwind | A MID-WRITE crash inside the mint verb's write loop (e.g. disk-full on the 2nd of N task writes) unwinds the partial FRESH-MINT tree via the verb's LOCAL try/except; the commit-failure window is NOT covered by this block |
| Keeper observation gate (fn-629 task .1, sole pre-commit guard) | An uncommitted `.planctl/epics/<id>.json` on disk does NOT produce an `EpicSnapshot` snapshot — the file lands in keeper's plan-worker `pending` set; once the file is committed (HEAD-resolvable via `git cat-file -e HEAD:<relpath>`), the next git-worker pulse drains pending and the snapshot emits. Autopilot cannot dispatch against an uncommitted epic |
| `epic rm` whole-tree delete | One `chore(planctl): rm <epic_id>` commit covers every unlinked path; touched paths recorded BEFORE unlink so `touched ∩ dirty` captures the deletions; `--dry-run` emits the same envelope shape minus `planctl_invocation` and lands no commit |
| `validate --epic` first-stamp | Manual `auto_commit_from_invocation` call from the runner lands the marker commit; bypasses `emit()` to preserve the `{valid, errors, warnings}` envelope shape |
| `epic followup-of` (read-only) | Envelope `{found, epic_id, actual_tasks, depends_on_epics, status}` for the first open epic whose `depends_on_epics` contains the source; `{found: false}` when none; envelope carries `subject=null`/`files=null`; no commit |

See `apps/planctl/tests/test_commit.py` for the auto-commit suite.

---

## Validation Marker

`normalize_epic` defaults `last_validated_at: null`. `scaffold` stamps
the marker on fresh epic mint. The 14 verbs in
`planctl/validation_restamp.py::VALIDATION_RESTAMP_VERBS` (the canonical
list — do not duplicate here) RE-STAMP the marker to a fresh
microsecond-precision `now_iso()` after their post-write integrity check
passes. `epic invalidate` is the ONLY surviving path that nulls the
marker.

`scaffold` is intentionally NOT in `VALIDATION_RESTAMP_VERBS` — it mints
a fresh epic and stamps the marker through its own scaffold-time path,
not the restamp helper. `done`, `claim`, `block`, `epic close`, ack
verbs (runtime, not structural), and `epic invalidate` (peer of
`validate`) are also out of the tuple. See the module docstring for the
full exclusion list.

### `validate --epic` stamp-then-commit asymmetry

`validate --epic <id>` writes `last_validated_at` to the epic JSON
**before** the auto-commit fires, not after. The marker-write block in
`run_validate.py` (the `if epic_def.get("last_validated_at") is None`
branch) calls `atomic_write_json(epic_path, epic_def)` first, then
invokes `commit.auto_commit_from_invocation(pc)`. This is the inverse
of the `VALIDATION_RESTAMP_VERBS` shape, where the restamp helper runs
the post-write integrity check and stamps the marker as part of the
same structural write that auto-commit then covers.

On commit failure the stamped epic JSON persists on disk (the
`atomic_write_json` already landed) and the runner prints the
structured `{"success": false, "error": "commit_failed", ...}`
envelope with exit 1 per §4. Because the stamp is now non-null on
disk, a re-run of `planctl validate --epic <id>` short-circuits the
marker-write block at the `if epic_def.get("last_validated_at") is
None` guard — no second `atomic_write_json`, no second commit attempt.
The re-run prints the
read-only `{valid, errors, warnings}` envelope and exits 0 (or 1 on
validation errors), which can surprise a human debugging the prior
commit failure.

Recovery is automatic but indirect: the dirty `.planctl/epics/<id>.json`
shows up in `git status`, and the **next** mutating planctl verb on
this epic (or any verb whose touched-paths intersect with the dirty
set) sweeps the stamped file into its own auto-commit via
`invocation._dirty_planctl_paths`. The stamp lands in history under
that next verb's `chore(planctl): <op> <target>` subject rather than
under a `chore(planctl): validate <id>` subject. Manual rescue is the
same shape as §10: `git add .planctl/epics/<id>.json && git commit -m
"chore(planctl): validate <id>"` if no follow-on verb is imminent, or
`git checkout -- .planctl/epics/<id>.json` to discard the stamp and
let a fresh `validate --epic` re-attempt.

This asymmetry is by design for this epic — fn-588 explicitly scopes
out rolling back the epic JSON write on commit failure. A future
change can revisit if the recovery surprise proves load-bearing.

**Seam coverage.** The migration that routed every single-field mutating
verb through the `output.emit()` seam (`verb=…` form) explicitly
**excluded** `validate --epic`. The verb's `{valid, errors, warnings}`
envelope shape is incompatible with `emit()` (which always wraps in
`{success: true, **data}`), so the runner keeps its direct
`commit.auto_commit_from_invocation(pc)` call. The single tracked
field this writes (`last_validated_at`) is a marker the next mutating
verb's auto-commit reliably sweeps from the dirty set, so its
stamp-persistence-after-commit-failure is bounded by the recovery path
documented above — there is no orphan-tree class of failure to worry
about here.

`refine-context --invalidate` (the other conditionally-mutating verb)
DOES route through the seam because its envelope shape
(`{success: true, ...}`) is `emit()`-compatible. The write is a
single-field rewrite of a pre-existing tracked file (atomic_write
rename-atomic), so prior valid contents stay in place on a pre-commit
raise — the invocation-build + commit lives inside the verb boundary.

---

## Migration Note

Three eras: pre-fn-31 commits were hand-rolled in each advice skill
with ad-hoc `git add .planctl/ && git commit` blocks. fn-31 → fn-488
landed commits via the hookctl `planctl-mutation` PostToolUse hook —
one commit per verb. fn-488 → fn-587 lifted commits into an explicit
seven-seam `planctl commit-plan <seam> <id>` verb fired at the boundary
of each `/plan:*` skill — one commit per skill, but `.planctl/` state
leaked whenever a mutating verb fired outside a skill. fn-587 collapses
the seam table into per-verb auto-commit at `output.emit()` — one
commit per verb, no skill cooperation required, no leak surface.

If your muscle memory has patterns like:

```bash
planctl epic close fn-7-add-auth
planctl commit-plan after-close fn-7-add-auth
```

Stop. Run `planctl epic close fn-7-add-auth`; the commit lands inline.
Skill templates have been updated to drop the trailing `commit-plan`
step.

See `git log -- apps/planctl/planctl/run_commit_plan.py` for the
seam-era detail.
