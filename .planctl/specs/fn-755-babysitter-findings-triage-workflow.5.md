## Description

**Size:** S
**Files:** claude/arthack/template/commands/babysit.md.tmpl (extend)

**DEFERRED / OPTIONAL — not on the critical path.** Once the ledger reliably tracks
processed findings, the unbounded `followups/` pile (246+ and growing) can be
bounded so it stops being the working set. Pick up only after tasks .1-.4 prove the
ledger in practice.

### Approach

Add an opt-in retention sweep to `/babysit` (a `--sweep` mode or an end-of-round
step): archive followup files whose `key` is ledgered with a terminal verdict
(`fixed`/`wontfix`/`landed-elsewhere`) AND not currently resurfaced, moving them into
`followups/archive/` rather than deleting (preserve the audit trail). Never touch
files for unprocessed or `routed`/`needs-work` keys. Keep it producer-agnostic — the
sweep reads the ledger, it does not change the scanner.

### Investigation targets

**Required:**
- claude/arthack/template/commands/babysit.md.tmpl (task .3) — where the sweep step plugs in
- babysitters/FINDINGS-LEDGER.md (task .1) — terminal-verdict + resurface definitions

### Risks

- Archiving a key that later resurfaces is fine (the scanner re-emits a fresh followup); deleting would lose the audit trail — archive, don't delete.

### Test notes

Dry-run the sweep (list what WOULD archive) before moving anything; confirm resurfaced and routed keys are never swept.

## Acceptance

- [ ] `/babysit` offers a retention sweep that archives (not deletes) followups for terminally-resolved, non-resurfaced keys
- [ ] Unprocessed / routed / needs-work / resurfaced keys are never swept
- [ ] Marked clearly as the deferred/optional stretch of the epic

## Done summary

## Evidence
