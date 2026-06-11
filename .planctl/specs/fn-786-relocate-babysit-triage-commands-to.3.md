## Description

**Size:** S
**Files:** babysitters/performance/README.md, babysitters/performance/charter.md, arthack-claude-plugin-inventory.md

### Approach

Update the durable triage-home + inventory docs in the `~/docs` git repo to name
the new commands and their keeper location. Pure reference renames; independent of
the arthack removal (task .2), so it can run in parallel with it after .1.

1. `babysitters/performance/README.md` line 26: `/babysit performance` → `/babysit-triage performance`.
2. `babysitters/performance/charter.md` lines 4 and 86: `/babysit performance` → `/babysit-triage performance`.
3. `arthack-claude-plugin-inventory.md`: line 46 — the `/arthack:babysit-new` row now belongs to keeper: update the command name to `keeper:babysit-init` and the source path to `~/code/keeper/commands/babysit-init.md` (the command left arthack). Line 167 — drop `babysit-new.md` from the arthack command file-layout line. Also ADD a row for the triage command (`keeper:babysit-triage`, `~/code/keeper/commands/babysit-triage.md`) — it was never previously inventoried. Keep bare command names (not fully-qualified) consistent with the existing doc style where the surrounding text already does so.
4. Commit in the `~/docs` repo. `~/docs` is a markdown-only repo with no lint matrix — commit via plain `git -C ~/docs add <paths> && git -C ~/docs commit -m "babysit: rename triage command refs to keeper:babysit-{init,triage}" && git -C ~/docs push` (matches the existing `~/docs` commit precedent). Stage only these three files.

### Investigation targets

**Required** (read before coding):
- ~/docs/babysitters/performance/README.md:26 — the `/babysit performance` ref
- ~/docs/babysitters/performance/charter.md:4,86 — the two `/babysit performance` refs
- ~/docs/arthack-claude-plugin-inventory.md:46,167 — the `/arthack:babysit-new` row + the arthack file-layout line

### Risks

- The inventory's namespace shift (`/arthack:babysit-new` → `keeper:babysit-init`) is the substantive edit — a naive command-name-only swap that leaves "arthack" as the plugin/source is wrong; the command's whole home changed.
- Don't touch `~/docs/keeper-reliability/2026-06-09-roadmap-state.md` (line ~246) — that `/babysit` mention is past-tense historical record, not a live instruction.

### Test notes

- `git -C ~/docs grep -nE '/babysit( |$)|babysit-new'` returns no live old-name refs in the three edited files afterward (roadmap historical mention may remain by design).

## Acceptance

- [ ] `babysitters/performance/README.md` (26) and `charter.md` (4, 86) name `/babysit-triage performance`
- [ ] `arthack-claude-plugin-inventory.md` reflects the keeper relocation: `babysit-new` row → `keeper:babysit-init` + keeper path, layout line cleaned, and a new `keeper:babysit-triage` row added
- [ ] Historical roadmap note left untouched
- [ ] Committed + pushed in the `~/docs` git repo (only the three files staged)

## Done summary
Renamed all live ~/docs references to the new keeper command names: /babysit-triage in performance README.md + charter.md, and the inventory's babysit-new row relocated to keeper:babysit-init plus a new keeper:babysit-triage row. Historical roadmap note left untouched.
## Evidence
