## Description

**Size:** S
**Files:** CLAUDE.md, README.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/SKILL.md

### Approach

Update docs to the final behavior, forward-facing (no change history). `CLAUDE.md`
(AGENTS.md is a symlink — edit CLAUDE.md in place, never rm+recreate): the agentbus
"separate cleanup system, never this repo" sentence → the generalized reaper owns
agentbus autoclose; "Two distinct reapers" → the third managed-session idle-grace arm.
`README.md`: the window-reaper predicate sections, the agentbus section, and the
config-keys block (add `disable-autoclose`, default empty). pair `SKILL.md`:
fire-and-forget + reaper-gate, drop `KEEPER_PAIR_PERSIST_SESSIONS`, note codex/pi keep
the synchronous reap. panel `SKILL.md`: panels closes after idle grace unless `panels`
is in `disable-autoclose`.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md ~35-43 (agentbus) + the autopilot "Two distinct reapers" section.
- README.md ~2815-2821, ~2967-2991 (window-reaper), ~3024-3027 (agentbus), ~363-416 (config keys).
- plugins/keeper/skills/pair/SKILL.md ~118; plugins/plan/skills/panel/SKILL.md ~84-86.

### Test notes

No code. Verify the documented `disable-autoclose` config-key name matches the implementation from tasks .2/.3.

## Acceptance

- [ ] CLAUDE.md/AGENTS.md agentbus + reaper sentences updated (forward-facing, no history).
- [ ] README window-reaper predicate, agentbus section, and config-keys block updated.
- [ ] pair + panel skills reflect fire-and-forget + idle-grace autoclose + `disable-autoclose`.

## Done summary

## Evidence
