## Description

**Size:** S
**Files:** CLAUDE.md, claude/CLAUDE.md, + whole-repo verification

Update the human-facing docs and gate the teardown with a holistic sweep.

### Approach

Rewrite the inter-agent guidance in `CLAUDE.md` (root) and `claude/CLAUDE.md`
to point at `keeper bus` (e.g. inter-agent → `keeper bus chat send`),
forward-facing — describe the current system, never narrate the chatctl→bus
change outside the commit message. Then run the FINAL VERIFICATION:
`grep -ri chatctl` over arthack (excluding .git/.venv/node_modules/
__pycache__/.keeper) returns clean (flag any residue); `launchctl list |
grep chatctl` empty; the workspace resolves; `keeper prompt render` of the
new bus bundle works; and (manually notable) a fresh session arms only the
keeper-bus monitor. Any residual chatctl reference found is either cleaned
here or, if it belongs to another task's surface, flagged.

### Investigation targets

**Required** (read before coding):
- CLAUDE.md (root) + claude/CLAUDE.md chatctl mentions (the inter-agent lines)
- the grep footprint from the epic References (to confirm each is handled)

### Risks

- This task is the gate: it depends on 1/2/3. If the sweep finds an unhandled chatctl reference, fix it here or surface it — do not mark done with residue.
- Exclude generated/lockfile/.keeper-history hits from the "clean" bar, but call them out.

### Test notes

The Quick commands in the epic spec are the verification checklist; all must pass.

## Acceptance

- [ ] CLAUDE.md + claude/CLAUDE.md inter-agent guidance points at keeper bus (forward-facing)
- [ ] `grep -ri chatctl` over arthack is clean (no live refs; any inert residue explicitly noted)
- [ ] chatctl daemon unloaded; workspace resolves; new bus bundle renders
- [ ] a fresh session arms only the keeper-bus monitor (no chatctl monitor)

## Done summary

## Evidence
