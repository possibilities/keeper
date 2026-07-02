## Description

**Size:** S
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, test/worktree-git.test.ts, test/autopilot-worker.test.ts, README.md

### Approach

After a successful `gitRemoveWorktree` (`{kind:"removed"}` ONLY — never on dirty), remove the husk directory when it holds nothing but `.claude` residue: a new bounded fs helper beside `removeWorktree` (src/worktree-git.ts:997) that (1) no-ops when the path is already gone; (2) lstat-walks (never stat) the dir; (3) proceeds only when every top-level entry is `.claude` and the walk contains only regular files/dirs — ANY symlink, device, socket, or `path.resolve` containment escape vetoes the whole deletion, leaving the dir untouched; (4) rm's the dir and then runs `git worktree prune` from the MAIN repo cwd (never from inside the removed path; prune is metadata-only and idempotent). Helper failures are swallowed-and-logged — teardown already succeeded and a minted failure row here would be an unactionable sticky jam. Wire it at both teardown sites: the finalize teardown loop (src/autopilot-worker.ts:4184-4192) and recover pass-3 rib prune (:4867-4879), each gated on ITS OWN repo's removed result (one repo's dirty outcome must not suppress another's cleanup). Add the README teardown sentence (~3557-3578).

The fs helper does real filesystem work, so its unit tests exercise it against per-test tmpdirs (fs in tests is fine; subprocess/git is not — the `git worktree prune` leg goes through the injected `run`).

### Investigation targets

**Required** (read before coding):
- src/worktree-git.ts:997-1032 — `removeWorktree` and the module's node-light helper conventions
- src/autopilot-worker.ts:4184-4192,4867-4879 — the two teardown call sites and their result gating
- test/worktree-git.test.ts:746-783 — the removeWorktree test family to extend

**Optional** (reference as needed):
- ~/worktrees husk examples pattern: a 0-byte dir containing only `.claude/` (live examples existed for fn-1019/1022/1045 today)

### Risks

- Deleting a dir with real ignored work (node_modules, .env) would be a serious blast-radius bug — the only-`.claude` gate plus symlink veto is the whole defense; test the abort paths as thoroughly as the happy path

### Test notes

Cover: only-`.claude` husk → removed + prune invoked; extra top-level entry → untouched; symlink inside `.claude` → untouched; already-gone path → no-op; helper throw → logged, teardown result unchanged; dirty removeWorktree result → helper never invoked.

## Acceptance

- [ ] Residue-only husks are removed and metadata pruned; anything else leaves the dir byte-untouched
- [ ] Helper failures never mint dispatch rows or alter teardown results
- [ ] Both call sites gated per-repo; full fast suite green

## Done summary

## Evidence
