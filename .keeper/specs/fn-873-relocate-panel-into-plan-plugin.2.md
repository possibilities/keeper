## Description

**Size:** S
**Files (arthack repo):** claude/arthack/skills/panel/SKILL.md, claude/arthack/skills/panel/references/panel.md, claude/arthack/agents/panel-judge.md

### Approach

In the arthack repo (worker cwd = /Users/mike/code/arthack via this task's target_repo), remove the panel skill dir and the judge agent now that they live in keeper's plan plugin. `git rm` the whole `claude/arthack/skills/panel/` dir + `claude/arthack/agents/panel-judge.md`, then commit + push. Run the `git rm` AND the commit in the SAME worker session — `keeper commit-work` is session-attribution-driven and scopes off cwd, so a split would strand the deletions. `commit-work` with cwd in arthack operates on the arthack repo; if it won't stage the deletions, fall back to explicit-path `git rm` + `git commit` + `git push`. NEVER `git add -A`/`git add .`. The arthack plugin keeps its design-taste + mrtasty skills; its `agents/` dir going empty is harmless.

This task DEPENDS ON `.1` — remove from arthack only after the keeper copy has landed, so the panel is never absent from both plugins at once.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/arthack/claude/arthack/skills/panel/ — the dir to remove
- /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md — the agent to remove

**Optional** (reference as needed):
- /Users/mike/code/keeper/cli/commit-work.ts — confirms commit-work keys off process.cwd() (cwd-in-arthack commits arthack)

### Risks

- Attribution is session-keyed: the `git rm` and the commit must happen in one worker session.
- Don't touch arthack's `.keeper/specs/` history.
- Push to arthack origin/main is network-dependent; a non-fast-forward rejection fails closed (retryable) — surface the envelope, don't force-push.

### Test notes

- `test ! -e /Users/mike/code/arthack/claude/arthack/skills/panel && test ! -e /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md` -> both gone.
- `git -C /Users/mike/code/arthack log --oneline -1` -> shows the removal commit.

## Acceptance

- [ ] The panel skill dir and panel-judge.md are removed from the arthack repo, committed, and pushed.
- [ ] arthack's other skills (design-taste, mrtasty) and its `.keeper/specs/` history are untouched.
- [ ] The removal landed after `.1` (the keeper copy) — verified the panel exists under plugins/plan/ before removing the arthack originals.

## Done summary
Removed the panel skill dir and panel-judge agent from arthack now that they live in keeper's plan plugin; committed and pushed to arthack origin/main. Sibling skills design-taste and mrtasty untouched.
## Evidence
