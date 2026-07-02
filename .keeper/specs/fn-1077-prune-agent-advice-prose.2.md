## Description

**Size:** M
**Files:** plugins/keeper/skills/{await,autopilot,dispatch,handoff,bus,pair}/SKILL.md

### Approach

The six keeper skills, one editorial pass each, no-op test sentence by sentence. await
(421 lines to ~250): collapse the three warning triplets (timeout-ownership, monitor-race,
server-up recovery) to one statement each at their condition-table rows; drop four of the
seven worked examples (keep the three teaching distinct shapes); trim What-NOT-to-do to
non-duplicated items; the condition table, armed-line envelopes, and reason/exit tables stay
verbatim. autopilot: one capture/restore statement, one --watch warning, delete the
name-collision aside (:30-32), trim bookends. Repoint the two forbidden pre-checks onto reads
the skills already fetch: await Step 1 (:132-160) and dispatch Step 1 (:104-122) currently
hand-parse keeper plan show --format json (file state, contra CLAUDE.md) — use the
status --json board read (or query tasks from the envelope epic) for existence/doneness.
Update the four orient-site markers to the pointer marker the corpus epic defined. dispatch/
handoff/bus/pair: bookend trims only where the body already states the rule — bus and pair
carry the densest sacred contracts, touch them least.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md:54-67,132-160,202-207,231-289,306-393,395-421
- plugins/keeper/skills/dispatch/SKILL.md:104-122,156-176,243-252
- plugins/keeper/skills/autopilot/SKILL.md:30-32,39-43,109-128,185-186,243-282
- The epic's sacred list — read before cutting anything

### Risks

- The prune's failure mode is deleting a discriminator that looks redundant but disambiguates for an unattended reader — when a line names a DIFFERENT trigger or exclusion, it is not a duplicate.

### Test notes

No behavior to run; review discipline: for every deleted line, name the surviving line that
carries its content. Verify quoted CLI shapes against the live commands post-envelope-epic.

## Acceptance

- [ ] await ~250 lines; all six skills bookend-deduped; sacred contracts verbatim
- [ ] No keeper skill hand-parses a keeper plan read; orient sites carry the pointer marker

## Done summary
Pruned redundant prose from the six keeper operator skills: collapsed await's three warning triplets and dropped 4 of 7 examples (421→301), repointed await/dispatch pre-checks off keeper plan show onto keeper query tasks / status --json, consolidated autopilot capture/restore + --watch to one statement each, and collapsed the duplicated What-NOT/Guardrails bookends across all six. Sacred contracts (failure taxonomy, envelope shapes, race-guard surface-and-ask, capture-restore, anti-spoof doctrine, pair BACKSTOP) verbatim-intact; bus untouched.
## Evidence
