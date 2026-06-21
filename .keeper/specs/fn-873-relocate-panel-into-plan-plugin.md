## Overview

The panel skill (`SKILL.md` + `references/panel.md`) and the `panel-judge` agent live in the arthack plugin and invoke as `arthack:panel` / `arthack:panel-judge`. This epic relocates them into keeper's plan plugin so the panel sits beside its only programmatic caller (`plan:hack`) and the daemon it pairs with, flipping the invocation namespace to `plan:panel` / `plan:panel-judge` and updating every live reference. End state: the panel is fully in keeper and gone from arthack.

## Quick commands

- `ls plugins/plan/skills/panel/SKILL.md plugins/plan/skills/panel/references/panel.md plugins/plan/agents/panel-judge.md` -> all three exist
- `grep -rn "arthack:panel" plugins/plan/ docs/planctl-strip.md` -> no matches (every ref flipped)
- `grep -c "plan:panel" plugins/plan/skills/hack/SKILL.md` -> >=4
- `test ! -e /Users/mike/code/arthack/claude/arthack/skills/panel && test ! -e /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md` -> gone from arthack
- `test ! -e plugins/plan/agents/panel-judge.md.managed-file-dont-edit` -> no sidecar (hand-authored static)

## Acceptance

- [ ] The panel skill + panel-judge agent exist under `plugins/plan/` and resolve as `plan:panel` / `plan:panel-judge` (plugin-name-derived; no manifest edit).
- [ ] Every `arthack:panel` / `arthack:panel-judge` literal is flipped across the moved files, `plan:hack`'s callsite (4 refs), and `docs/planctl-strip.md` (1 ref) — `grep -rn "arthack:panel" plugins/plan/ docs/planctl-strip.md` is empty.
- [ ] The plan plugin's own enumerations are current: README.md skill table has a `/plan:panel` row; CLAUDE.md names `panel-judge`.
- [ ] The originals are removed from the arthack repo and the removal is committed + pushed; arthack's other skills are untouched.
- [ ] All prose forward-facing (no "moved from arthack" breadcrumbs); panel stays model-invokable.

## Early proof point

Task that proves the approach: `.1` (the keeper-side addition + namespace flip). If `plan:panel` doesn't resolve after landing (auto-discovery / reload issue), keep the arthack copy in place until it does — do NOT let `.2` (the arthack removal) run before `.1` is verified, so the panel is never absent from both plugins.

## References

- Claude Code plugins/skills/subagents docs — plugin `name` is the namespace prefix; skill name = `<plugin>:<skill-dir>`; flat `agents/panel-judge.md` -> `plan:panel-judge`; `agents/` changes need `/reload-plugins` in a live session (SKILL.md text hot-reloads).
- Verified dispatch mechanism: a worker launches with cwd = `task.target_repo ?? epic.project_dir` (src/autopilot-worker.ts), and `keeper commit-work` scopes off `process.cwd()` (cli/commit-work.ts) — so a `target_repo`-tagged task commits in that repo. keeper attributes arthack mutations; the branch-guard permits git rm/commit/push.
- Forward-facing docs rule: `promptctl render future-facing-docs`.

## Best practices

- **Flip every namespace literal with the move** — there is no load-time validation of cross-skill name references; a stale `arthack:panel` string makes the model invoke a nonexistent skill at runtime. Grep must come back empty.
- **No plugin.json edits, no panel-judge sidecar/.tmpl** — both plugins auto-discover by directory, and panel-judge is a hand-authored static agent (like close-planner.md), not a generated one.
- **Remove from arthack only after the keeper copy lands** (`.2` depends on `.1`) — avoid a window where the FQN resolves to nothing.
- **One worker session per repo commit** — `commit-work` is session-attribution-driven; the `git rm` and its commit must run in the same arthack worker session.
