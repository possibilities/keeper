# Commit at the Mutation Boundary

**Status:** Authoritative
**Applies to:** planctl CLI v1 (fn-587 and later)

This memo is the single source of truth for planctl's commit contract. All
other docs that describe commit behavior defer to this file.

Every mutating planctl verb commits its own `.planctl/` scope inline at
the verb boundary. There is no `commit-plan` verb, no skill-seam table,
no deferral mechanism, no skill cooperation needed. The runner-side
`output.emit()` call lands the `chore(planctl): <op> <target>` git
commit under the shared flock, then prints the `success: true`
envelope. An envelope on stdout means the commit landed.

---

## 1. Per-Verb Auto-Commit Principle

Every planctl verb that mutates `.planctl/` carries its own commit. The
verb knows mechanically which files it touched, derives a deterministic
subject from its `op` and `target`, acquires the per-host flock, stages,
commits, releases. No agent-authored commit messages. No outer skill
coordination. No "what landed since last time" audit-table scan.

The principle replaces the seven-seam `commit-plan` model
(fn-488 → fn-587). The seam model leaked state whenever a mutating verb
fired outside a `/plan:*` skill — notably `approve` (formerly
`set-approval`) from a human-typed CLI. The per-verb model is
fail-safe at the verb: any path that emits a `planctl_invocation`
envelope commits its own scope.

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
   `commit.auto_commit_from_invocation(payload)`. The helper:
   - No-ops when `files` is `None`/`[]` (read-only verb, runtime-only
     verb, or no dirty intersection).
   - Resolves the cwd from `payload['state_repo']` (with a stderr-noisy
     fallback to `payload['repo_root']`).
   - Acquires `LOCK_EX` on `$GIT_COMMON_DIR/planctl-commit.lock` (60s
     timeout; see §7).
   - Re-confirms dirtiness under the lock via
     `git diff --cached --quiet -- <files>` ∪ `git diff --quiet -- <files>`;
     returns `None` if a concurrent verb already swept the files.
   - Captures `HEAD` SHA as `Planctl-Prev-Op`.
   - Stages with `git add -- <files>` (explicit pathspecs only — never
     `-A`, never `.`).
   - Commits with `git commit -F -` piping the message on stdin.
   - Releases the flock (kernel-released on process exit regardless).
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

`queue_jump` (optional, bool, default `false`) is set by `/plan:queue`
on its scaffold invocation and rides through the existing scaffold
path unchanged (no new role-launcher plumbing, no new CLI flag). It is
the server-derived signal keeperd folds into the `epics.queue_jump`
projection column (schema v30) to drive the `!`-prefix `sort_path`
branch in `cascadeSortPath`. Old envelopes lacking the key fold to
`false` per the standard `?? false` lift, preserving re-fold
determinism. `/plan:defer` produces the same envelope shape with
`queue_jump: false` (or omitted entirely).

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

As of fn-629 (tasks .2 + .3), `output.emit()` owns the write→commit
transaction for every mutating verb routed through the seam: it builds the
`planctl_invocation` payload itself (the build moved INTO emit), then
invokes `auto_commit_from_invocation`. Callers pass `verb=`, `target=`,
`repo_root=`, and a `written_paths: list[Path]` carrying every freshly-minted
path; on ANY pre-commit raise (invocation-build failure, commit-lock
timeout, or a git status/add/commit error) `emit()` unwinds
`written_paths` before re-raising. The unwind stops at the commit boundary:
once `auto_commit_from_invocation` lands, files are tracked in HEAD and
are never unlinked (§10 no-rollback is preserved post-commit). The commit
lock (`$GIT_COMMON_DIR/planctl-commit.lock`) is acquired INSIDE
`auto_commit_from_invocation`, not at the seam — `_epic_id_lock` (the
sub-millisecond id-allocation lock in `run_epic_create`) stays disjoint
from the commit lock; the two are never nested.

| Class | Envelope | Auto-commit | Seam |
|---|---|---|---|
| Mutating, single-field (`done`, `approve`, `epic close`, `epic invalidate`, `epic add-dep`/`add-deps`/`rm-dep`, every `epic set-*` / `task set-*`, `task reset`, ...) | non-null `subject`, populated `files` | yes (inline) | seam (`written_paths=[]` — every write is a rewrite of a pre-existing tracked file via atomic_write rename-atomic; prior valid contents stay in place on a pre-commit raise, so there is nothing to unwind) |
| Mutating, whole-tree (`scaffold`, `refine-apply`, `epic create`) | non-null `subject`, `files` covers the full epic+tasks+specs+deps tree | yes (inline, one commit) | seam (`written_paths=[<every fresh-mint path>]` — emit unwinds on pre-commit raise so a failed commit leaves zero on-disk side effects) |
| Mutating, whole-tree delete (`epic rm`, fn-623) | non-null `subject`, `files` lists every unlinked path (epic JSON, every task JSON, epic + task specs, runtime state, locks) — paths are recorded BEFORE the unlink so the `touched ∩ dirty` pathspec captures the deletions | yes (inline, one commit) | seam (`written_paths=[]` — the verb is a delete, nothing to unwind on pre-commit raise) |
| Runtime-state-only (`claim`, `block`) | `subject=null`, `files=null` | none (gitignored state) | n/a |
| Read-only (`show`, `cat`, `list`, ...) | `subject=null`, `files=null` (via decorator) | none | n/a |
| `validate --epic <id>` (first-ever valid) | non-null `subject`, single file | yes (manual `auto_commit_from_invocation` call from the validate runner, which bypasses `emit()` to preserve its `{valid, errors, warnings}` envelope shape) | bypass — documented out-of-scope per §13's `validate --epic` row, see the asymmetry note below |
| `refine-context --invalidate` (conditionally-mutating) | non-null `subject`, single file | yes (inline) | seam (envelope shape is `emit()`-compatible; the single-field rewrite is a rename-atomic over a pre-existing tracked file, so `written_paths=[]`) |

`scaffold` is one mutating invocation that spans many `atomic_write` calls but
emits exactly **one** envelope and produces one git commit covering every
written path. `refine-apply` is its sibling on an existing epic: post-fn-629
task .2, its Phase 4.5 re-write rides inside the seam (the pre-task-.2
"outside-lock re-write with no unwind" bug is fixed), so a pre-commit
raise unwinds the freshly-minted task/spec tree the same way scaffold does.

**keeper-side observation gate.** keeper's plan-worker producer (the
file watcher folding `.planctl/{epics,tasks}/*.json` into the `epics`
projection) gates snapshot emission on a synchronous `git cat-file -e
HEAD:<relpath>` check — until the file is in HEAD, no
`EpicSnapshot`/`TaskSnapshot` is emitted and the autopilot cannot
dispatch against it. The pair (planctl commits at the seam; keeper
refuses to observe pre-commit files) closes the fn-627 duplicate-dispatch
window end-to-end. See `~/code/keeper/CLAUDE.md` § Autopilot dispatch
gates and `~/code/keeper/README.md` § Architecture (the **fourth**
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
| `lock_timeout` | 60s flock acquisition timed out. `details` carries `holder_pid`/`holder_cmdline` if the lockfile was readable. |
| `git_status` | `git status` / `git diff` plumbing call failed. |
| `git_add` | `git add -- <files>` failed (e.g. pathspec error, permission). |
| `git_commit` | `git commit -F -` failed (hook rejected, gpg failed, etc.). |
| `missing_state_repo` | Payload lacked both `state_repo` and `repo_root` — envelope-shape drift. |
| `missing_subject` | Payload lacked a `subject` — envelope-shape drift. |

**Pre-commit failure unwind (fn-629 task .2).** Every seam-routed verb
passes its freshly-minted paths to `emit(written_paths=[...])`. On a
pre-commit raise — invocation-build failure (e.g. missing
`PLANCTL_SESSION_ID`), commit-lock timeout, or a git status/add/commit
error — `emit()` unwinds those paths before re-raising, so a failed
commit leaves zero on-disk side effects for the multi-file verbs
(`scaffold`, `refine-apply`, `epic create`, `epic rm`). The
single-field seam-routed verbs (`done`, `approve`, every `set-*`, etc.)
pass `written_paths=[]` because each write is a rename-atomic rewrite of
a pre-existing tracked file — the prior valid contents stay in place on
a pre-commit raise, so there is nothing to unwind. Either shape lands
the failure envelope on stdout and exits 1 with zero new untracked
files on disk.

**Post-commit failure persists on disk.** The unwind STOPS at the
commit boundary inside `auto_commit_from_invocation`. Once `git commit`
returns success, no further failure path inside the helper exists —
files are tracked in HEAD and will never be unlinked by the seam (§10
no-rollback policy preserved).

**`validate --epic` (the seam-bypass verb)** is the one remaining
write-persists-on-failure case: the runner calls
`auto_commit_from_invocation` directly to preserve its `{valid,
errors, warnings}` envelope shape, so its single-field
`atomic_write_json` (`last_validated_at` stamp) lands BEFORE the commit
and persists on disk on a commit failure. See §13's "validate --epic
stamp-then-commit asymmetry" sub-section for the full reconcile path —
the dirty file is swept into the next mutating verb's auto-commit.

Reconcile path for either shape: re-run the verb (idempotent for most
stamping verbs) or `git checkout -- .planctl/` to discard any persisted
state. For an orphan epic tree that survived a hard `commit_failed` (a
pre-fn-629-task-.2 verb, or a runaway), the orphan-epic reaper at the
next `scaffold` / `refine-apply` pre-flight sweeps it automatically —
see §10 for the reaper contract.

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
```

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

## 6. Source-Code Commits: `jobctl commit-work`

Source-code commits are not auto-commit territory. Workers commit via
`jobctl commit-work`:

```bash
jobctl commit-work --preview-files
jobctl commit-work "feat(scope): add the feature

Task: fn-7-add-auth.2"
```

`jobctl commit-work` uses its own flock at
`$GIT_COMMON_DIR/jobctl-commit.lock`. Planctl's
`auto_commit_from_invocation` uses its own flock at
`$GIT_COMMON_DIR/planctl-commit.lock`. The two locks are independent —
jobctl source commits and planctl `.planctl/` auto-commits target
disjoint pathspecs, so they do not need to serialize against each
other on the same host.

### Push semantics

`jobctl commit-work` **always pushes** to origin after a successful
commit — no `--no-push` flag, no CLI-side retry, no rollback of the
commit on push failure. The CLI emits two NDJSON envelopes:

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

`jobctl commit-work` runs lint inside the flock against the
session-scoped file set:

- **Ruff (Python)** when `pyproject.toml` exists and at least one staged
  file has a `.py` suffix.
- **npm lint (JS/TS)** when `package.json` exists with a `lint` script
  and at least one staged file has a JS/TS suffix.

Both linters run before raising. If either fails, the CLI emits
`{"success": false, "error": "lint_failed", "linter": "ruff"|"npm"|"both", "stderr": "..."}`
and exits 1.

---

## 7. Per-Host Commit Flock

Planctl's `auto_commit_from_invocation` takes an exclusive blocking
flock on `$GIT_COMMON_DIR/planctl-commit.lock` for the full stage →
commit window. `jobctl commit-work` uses its own independent flock at
`$GIT_COMMON_DIR/jobctl-commit.lock` for the stage → lint → commit →
push window. The two locks are not shared: planctl auto-commits and
jobctl source commits target disjoint pathspecs, so cross-tool
serialization on the same host is not required.

- **Acquisition**: `fcntl.flock(fd, LOCK_EX)` — blocking, 60-second
  timeout.
- **FD flags**: `O_CLOEXEC` so child processes do not inherit the lock.
- **Lockfile contents**: holder PID + cmdline written on acquisition for
  diagnostic timeout errors.
- **Release**: kernel auto-releases on process exit or crash
  (SIGKILL-safe). Explicit `flock(fd, LOCK_UN)` on normal exit.

Rooted at `$GIT_COMMON_DIR` (not `.git/`) so the lock serializes across
all worktrees that share the same object store.

Two planctl mutating verbs on the same host serialize on the planctl
lock; two `jobctl commit-work` invocations serialize on the jobctl
lock. Cross-host races are not covered by either flock; the human
resolves any cross-host `non_fast_forward`.

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

Consumers (keeperd, jobctl readers) read `.planctl/state/acks.db` and
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
   the worker's `jobctl commit-work "<msg>"` commits source code and
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
  `in_progress`, source uncommitted. `jobctl session-state` shows dirty
  `session_files`. Warm SendMessage resume asks the resumed worker to
  finish + commit + done. Cold spawn takes the HARNESS_DROPPED carve
  and continues from Phase 3.
- **Drop between source commit and `planctl done` (source committed,
  not done):** task `in_progress`, `jobctl find-task-commit $TASK_ID`
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
- **Pre-commit unwind** (fn-629 task .2, seam-routed verbs): for the
  multi-file verbs (`scaffold`, `refine-apply`, `epic create`, `epic
  rm`), `emit()` unwinds `written_paths` on any pre-commit raise — the
  failed verb leaves zero on-disk side effects. For the single-field
  seam-routed verbs (`done`, `approve`, every `set-*`, etc.), each
  write is a rename-atomic rewrite of a pre-existing tracked file, so
  prior valid contents stay in place on a pre-commit raise.
- **Post-commit, no rollback**: once `git commit` returns success,
  files are tracked in HEAD; the seam never unlinks them. No partial
  rollback is attempted. Build-forward: fail visibly, let the human
  reconcile.
- **`validate --epic` bypass** is the one remaining
  write-persists-on-failure shape (§4 + §13).

Reconcile path:

```bash
# Option A — rerun the verb (idempotent for stamping verbs)
planctl done fn-7-add-auth.2 --summary "..."

# Option B — discard the writes
git checkout -- .planctl/
```

### Orphan-epic reaper (fn-629 task .4)

A hard `commit_failed` from a pre-fn-629-task-.2 verb (or any future
runaway) could historically leave a fully-written but untracked epic
tree on disk: keeper's plan-worker observation gate (§3) refuses to
emit a snapshot for an uncommitted epic, no worker ever touches it,
and no later mutating verb on a different epic revisits its files —
the §10 "next mutating verb sweeps it" promise was, before task .4,
true ONLY for files the next verb's `touched ∩ dirty` intersected.

`planctl.reaper.reap_orphan_epics` makes that promise real for the
disjoint case. The reaper runs as a Phase-3 pre-flight at the top of
`scaffold` and `refine-apply` and unlinks every epic tree (epic JSON
+ tasks + specs + runtime state + locks, mirroring `epic rm`'s
unlink set) whose `.planctl/epics/<id>.json` is git-untracked.

**Safety gate — two conjoined predicates, both must hold before reap:**

1. **Stale by mtime.** Epic JSON mtime older than
   `_REAP_MIN_AGE_SECONDS` (5 minutes). Any in-flight write is
   sub-second; 5 minutes is conservative beyond the 60s commit-lock
   timeout plus realistic clock skew.
2. **No live session owns the project.** No file under
   `.planctl/state/sessions/<sid>/touched/` has been modified within
   `_LIVE_SESSION_WINDOW_SECONDS` (10 minutes). The touched-paths
   log is written by every `atomic_write` / `_record_touched`, so a
   freshly-running session leaves recent timestamps regardless of
   whether the specific touched-path file names the orphan epic.
   Coarse on purpose — naming-specific matching would race the write
   that creates the touched-record itself, and waiting one verb-cycle
   to reap costs nothing.

When in doubt, do NOT reap. The reaper is fail-soft (a sweep error
never blocks the actual scaffold/refine-apply), idempotent, and
explicitly preserves the fn-627 in-flight pre-commit window: a fresh
untracked tree owned by a live session is regression-tested as
NOT-reaped. The reaper is the planctl-side complement to keeper's
observation gate — together they close gap (2) of the §10
no-rollback policy: even when files persist post-failure, no worker
ever sees them and the next mutating verb sweeps them up.

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
and no `fcntl` dance is needed. `scout promote` / `interview promote`
(now removed) historically called `_record_touched()` explicitly after
each `shutil.move` (which bypasses `atomic_write`).

At envelope-build time, `build_planctl_invocation`:

1. Reads all touched-path records for the session via
   `_read_touched_paths` (path validation happens here — see §11).
2. Calls `_dirty_planctl_paths` (`git status --porcelain
   --untracked-files=all -- .planctl/`) to get the current dirty set.
3. Intersects the two sets — only paths that are both touched and dirty
   appear in `files`.

`auto_commit_from_invocation` re-intersects under the flock to handle
the race where a concurrent verb already swept the files between
payload-build and lock-acquire.

### Fail-closed on None session id

`invocation.py::build_planctl_invocation` resolves the session id from
the `PLANCTL_SESSION_ID` env var — the sole source. The claude
launcher exports this for every spawned session; tests and manual
invocations set it explicitly.

If `PLANCTL_SESSION_ID` is unset / empty, `build_planctl_invocation`
raises `RuntimeError` naming the env var — no process-tree walk, no
wildcard fallback.

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
| Auto-commit failure | No success envelope on stdout; failure envelope with `error: commit_failed` and `details.error` ∈ {`lock_timeout`, `git_*`, `missing_*`}; exit 1 |
| Lock contention | Mutating verb blocks until lock available; on 60s timeout raises `CommitFailed("lock_timeout", ...)` and exits via failure envelope |
| Concurrent-sweep race | Verb A commits the files; Verb B sees clean files under the lock and returns `None` (no empty commit) |
| `done` verb | `chore(planctl): done <task_id>` commit lands in one verb call |
| `task ack` | Writes `acks.db` only; no commit; envelope carries `subject=null`/`files=null` |
| `approve` (paradigmatic leak case, formerly `set-approval`) | Verb fires from any cwd (no `/plan:*` skill) — commit still lands |
| `scaffold` whole-tree | One commit covers epic + tasks + specs + deps; envelope `files` lists every written path |
| `scaffold` integrity-gate failure (fn-623) | `scan_max_epic_id` unchanged; zero orphan `specs/fn-N-*.md` on disk (in-memory `epic_spec_content=` pass means no spec lands before the gate); failure envelope only, no commit |
| Seam pre-commit unwind (fn-629 task .2) | Multi-file seam-routed verb raises BEFORE `auto_commit_from_invocation` returns (invocation-build raise, lock-timeout, or simulated `git` failure); `emit(written_paths=[...])` unwinds every freshly-minted path on the way out; zero new untracked files in `.planctl/` after the failure envelope lands; `_epic_id_lock` and the commit lock remain disjoint (no nesting regression) |
| Keeper observation gate (fn-629 task .1) | An uncommitted `.planctl/epics/<id>.json` on disk does NOT produce an `EpicSnapshot` snapshot — the file lands in keeper's plan-worker `pending` set; once the file is committed (HEAD-resolvable via `git cat-file -e HEAD:<relpath>`), the next git-worker pulse drains pending and the snapshot emits. Autopilot cannot dispatch against an uncommitted epic |
| Orphan-epic reaper safety (fn-629 task .4) | Stale (>5min) untracked orphan epic tree with NO live session activity in the last 10min → reaped by the next `scaffold` / `refine-apply` pre-flight (every artifact `epic rm` would unlink, gone); fresh in-flight untracked tree owned by a live session (recent touched-paths-log mtime) → NOT reaped (the fn-627 window stays safe); tracked epic tree → never touched; reaper exception → swallowed, scaffold/refine-apply proceeds |
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
not the restamp helper. `done`, `claim`, `block`, all
`set-*-review-status`, `epic close`, ack verbs (runtime, not
structural), and `epic invalidate` (peer of `validate`) are also out of
the tuple. See the module docstring for the full exclusion list.

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

**fn-629 task .3 seam coverage.** The migration that routed every
single-field mutating verb through the `output.emit()` seam (`verb=…`
form, written_paths-as-unwind) explicitly **excluded** `validate
--epic`. The verb's `{valid, errors, warnings}` envelope shape is
incompatible with `emit()` (which always wraps in `{success: true,
**data}`), so the runner keeps its direct
`commit.auto_commit_from_invocation(pc)` call. The single tracked
field this writes (`last_validated_at`) is a marker the next mutating
verb's auto-commit reliably sweeps from the dirty set, so the absence
of a parallel unwind wrapper is bounded by the existing recovery path
documented above — there is no orphan-tree class of failure to worry
about here, only the documented stamp-persistence-after-commit-failure
surprise.

`refine-context --invalidate` (the other conditionally-mutating verb)
DOES route through the seam as of fn-629 task .3 because its envelope
shape (`{success: true, ...}`) is `emit()`-compatible. The write is a
single-field rewrite of a pre-existing tracked file (atomic_write
rename-atomic), so `written_paths=[]` — no unwind, but the
invocation-build + commit transaction lives inside one try-block per
the seam contract.

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
