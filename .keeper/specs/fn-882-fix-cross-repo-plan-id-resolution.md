## Overview

Cross-repo (multi-repo-root) `keeper plan` epics can't be stamped by their
own workers. A task with `target_repo=<other>` dispatches a worker whose cwd
is that repo; when the worker runs `keeper plan done <id>` (or `show <id>`),
the CLI resolves the plan project from CWD — the target repo's project — not
the epic's OWNING project, so a globally-unique id owned by another repo's
plan board returns "Task not found".

Hit live during fn-879 (teardown epic owned by keeper's plan board, tasks
targeting `~/code/arthack`): the arthack worker committed its work fine but
could not stamp the task done — `keeper plan done` from arthack's cwd hit
arthack's board (caps at a different id range), not keeper's. It had to be
hand-stamped from keeper's cwd. As the keeper↔arthack split makes cross-repo
epics routine, this needs a real fix so cross-repo workers self-complete.

The fix: make the ID-addressed verbs resolve a bare `fn-N[.M]` id
cwd-then-GLOBAL, reusing the existing `resolve_epic_globally` pattern that
`keeper plan epic add-deps` already uses (ids are globally unique, so a bare
id should resolve regardless of cwd). `list` stays project-scoped (it's a
board view); the id-addressed verbs (`show`, `cat`, `done`, refine-context,
and any other that takes a concrete id) should find the id wherever it lives.

## Quick commands

- From repo A's cwd, scaffold a task; from repo B's cwd run `keeper plan done <that-task-id>` → it resolves + stamps (today it fails "Task not found")
- `bun test` over the plan resolution tests (fast tier) + `bun run test:full` for any process-level plan paths

## Acceptance

- [ ] `keeper plan done <fn-N.M>` and `keeper plan show <fn-N>` resolve a globally-unique id cwd-then-global (via `resolve_epic_globally` or equivalent), so a worker in a non-owning repo's cwd can stamp/read a task owned by another repo's plan board
- [ ] The fix reuses the existing global-resolution helper rather than a new ad-hoc path; ambiguity (legacy dup ids) surfaces the same SKIPPED_AMBIGUOUS-style signal add-deps uses
- [ ] A regression test exercises the cross-repo case: a task created in plan project A is stamped done from project B's cwd
- [ ] `keeper plan list` semantics are unchanged (still the cwd project's board)
- [ ] No change to the on-disk store layout; existing single-repo flows unaffected

## Early proof point

Task that proves the approach: `.1` — once `keeper plan done <id>` resolves
globally, the exact fn-879 failure can't recur. If global resolution proves
too broad (legacy ambiguous ids), the fallback is a `--state-repo`/`--project`
override flag the autopilot dispatch sets for cross-repo tasks.

## References

- Existing global-resolution pattern: `resolve_epic_globally` (used by `keeper plan epic add-deps` — "dep-id existence resolves cwd-then-global; bare fn-N is the only syntax, ids globally unique").
- The done/show verb dispatch + project resolution lives in `plugins/plan/src/` (the `keeper plan` CLI). `keeper plan detect` is the cwd→project resolver to study.
- Live incident: fn-879 cross-repo teardown — arthack worker's `keeper plan done fn-879-…3/.4` failed "Task not found" from arthack cwd; hand-stamped from keeper.
