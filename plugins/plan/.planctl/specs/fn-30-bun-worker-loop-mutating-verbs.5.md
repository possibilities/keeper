## Description

**Size:** M
**Files:** src/verbs/init.ts, src/verbs/done.ts, src/specs.ts (new), src/cli.ts, test/ additions

### Approach

The committing pair. init: bootstrap .planctl/{epics,specs,tasks}/ + state/{tasks,locks}/, meta.json via atomicWriteJson, .planctl/.gitignore containing `state/` (raw write), CLAUDE.md advice file only when absent (preserve human edits; content literal from the Python source), AGENTS.md as a RELATIVE symlink to CLAUDE.md; idempotent re-run writes nothing and emits read-only with no commit; self-commit via a LITERAL payload (files = sorted written list, no session id key, no touched-log involvement) only when files were written AND findGitRoot resolves a work tree — in a non-git dir init writes files, emits success, exits 0, no commit. done: specs.ts ports patch_task_section + ensure_valid_task_spec byte-exactly (section patching is whitespace-sensitive; the four-H2 template shape is the contract); under lockTask gate (already-done error; non-force requires in_progress + assignee match), patch `## Done summary` and `## Evidence`, atomicWrite the spec, saveRuntime(done); after the lock, stamp updated_at + worker_done_at on the TRACKED task JSON via atomicWriteJson; clear the work marker; emit through the mutating seam (this is the wave's committing verb — one compact envelope line, commit before print). Register both in cli.ts.

### Investigation targets

**Required** (read before coding):
- planctl/run_init.py — bootstrap file set, literal payload, work-tree branch
- planctl/run_done.py — lock-phase vs after-lock writes, gates, stamps
- planctl/specs.py — patch_task_section/ensure_valid_task_spec exact mechanics
- tests/test_init.py — the existing conformance assertions init must satisfy as-is
- tests/test_worker_verbs.py — done's landed pins

**Optional** (reference as needed):
- src/project.ts findGitRoot — the work-tree probe to reuse
- planctl/run_init.py CLAUDE_MD_CONTENT — the advice-file literal to carry over byte-exactly

### Risks

done's two-phase write (spec under lock, task JSON after) must match Python's ordering exactly — parity includes the partial-state window. init's advice-file preservation (never overwrite an existing CLAUDE.md) is a data-loss guard; the symlink must be relative or the repo breaks when moved.

### Test notes

tests/test_init.py green via dist/planctl-bun (real git, self-commit counts, symlink, idempotency, non-git no-commit); test_worker_verbs.py done selections green; frozen-clock stamp equality holds.

## Acceptance

- [ ] test_init.py green against the compiled binary unmodified
- [ ] done: one commit with byte-identical subject/trailers, worker_done_at on tracked JSON, spec sections patched byte-stably
- [ ] init in non-git dir: success envelope, exit 0, zero commits; idempotent re-run commits nothing

## Done summary
Ported the committing worker pair to planctl-bun: init (bootstrap + advice files + literal self-commit inside a git work tree) and done (two-phase write — spec under lock, worker_done_at on the tracked JSON after — via new specs.ts byte-stable section patching). Scoped conformance gate (test_cli/readonly/init/worker_verbs) green against the compiled binary with --run-slow; docs updated for the worker-loop writes.
## Evidence
