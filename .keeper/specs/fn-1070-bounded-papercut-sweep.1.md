## Description

**Size:** S
**Files:** src/pair/panel.ts, src/worktree-git.ts, plugins/plan/scripts/promote.sh

### Approach

Three mechanical, individually-verified fixes. (1) src/pair/panel.ts:662 embeds a literal NUL byte (0x00) in the liveness-memo key template, which makes the whole file read as binary to file/BSD grep/git grep; replace with the escape "\0" (byte-identical key at runtime) and check no test pins the raw byte. (2) src/worktree-git.ts:468 hasMergeInProgress: the export is dead (the one caller is intra-file, abortInterruptedMerge:489); drop the export keyword, keep the function. (3) plugins/plan/scripts/promote.sh:48-56 second drift guard: it diffs git status of plugins/plan/agents, but verify what it can actually catch on the CURRENT tree shape (agents/ holds committed hand-authored files plus a gitignored generated one; worker cells render elsewhere) before touching it — delete only if provably redundant with the fast-tier generated-guard test, otherwise repoint it at a real render-diff check. Note promote.sh will already have been reshaped by the slow-tier-gate epic; work against its landed form.

### Investigation targets

**Required** (read before coding):
- src/pair/panel.ts:662 — the NUL site (use grep -a or od -c; plain grep skips the file)
- plugins/plan/scripts/promote.sh — current step order post slow-tier-gate epic
- plugins/plan/.gitignore — exactly which agents/ contents are ignored

### Test notes

After (1): `file src/pair/panel.ts` reports text and `git grep hasSeenPid -- src/pair/panel.ts`-style searches hit; panel tests green. After (3): document in Evidence what the guard could/couldn't catch and why the chosen action is safe.

## Acceptance

- [ ] No raw NUL bytes in src/pair/panel.ts; panel memo behavior unchanged; tests green
- [ ] hasMergeInProgress no longer exported; function retained
- [ ] promote.sh guard deleted-or-repointed with the redundancy argument recorded in Evidence
- [ ] `bun test` and plugins/plan tests green

## Done summary
Swept three verified papercuts: replaced the raw NUL in panel.ts's liveness memo key with a \0 escape (file now reads as text, key byte-identical at runtime), dropped the dead export on worktree-git.ts hasMergeInProgress, and removed promote.sh's provably-dead git-status drift guard while keeping the render that feeds the slow-tier cell-set guard.
## Evidence
