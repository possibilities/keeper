## Description

**Size:** S
**Files:** CLAUDE.md, README.md, plugins/keeper/skills/autopilot/SKILL.md, cli/autopilot.ts

### Approach

Forward-facing docs only (state current behavior; no change-history). Update
CLAUDE.md (autopilot section: the `worktree_mode` toggle + topology module +
producer git driver; hook-rules: clarify the branch-guard does NOT fire for
the daemon producer that shells git directly, but STILL blocks plan-worker
subagents). Update README ## Architecture (autopilot worktree lifecycle;
branch-guard narrative; commit-work skip-push-in-worktree). Update the
keeper:autopilot SKILL.md (arg-hint + the take-over capture set must include
worktree_mode). Add the `worktree` subcommand to the cli/autopilot HELP string.
NOTE: the scoped-write-surface RPC list in CLAUDE.md is NOT extended — worktree_mode
rides fn-953's `set_autopilot_config`, adding no new RPC.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md autopilot section (~117-119), hook-rules (~44-46), scoped-write list (~66-68 — do NOT add an RPC).
- README.md ## Architecture autopilot narrative (~1075-1165), branch-guard (~1623-1631).
- plugins/keeper/skills/autopilot/SKILL.md (arg-hint, dispatch table, take-over capture set).
- cli/autopilot.ts HELP (~46-89).

### Risks

- `bun scripts/lint-claude-md.ts` gates CLAUDE.md size + bans re-narration — keep it green; prune as readily as add.

### Test notes

`bun scripts/lint-claude-md.ts` green; no test code.

## Acceptance

- [ ] CLAUDE.md, README, SKILL.md, and cli/autopilot HELP describe worktree mode (toggle, lifecycle, branch-guard producer carve-out, commit-work push-skip) forward-facing.
- [ ] The take-over capture set in the autopilot skill includes worktree_mode.
- [ ] No new RPC added to the scoped-write list; lint-claude-md green.

## Done summary

## Evidence
