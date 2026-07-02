## Description

**Size:** M
**Files:** README.md, CLAUDE.md, src/backup.ts, cli/reclaim.ts, cli/board.ts, src/usage-picker.ts, src/db.ts

### Approach

Rewrite README.md top to bottom as a lean front door, target ≤250 lines AND ≤24576 bytes
(task 2 hard-gates these numbers — land under them). Delete-maximalist directive from the
human: "Keep as little as possible, delete as much as possible. Unless there's some
extremely strong reason to relocate some content elsewhere, delete it." Git history is the
archive; put ONE line in the commit message noting the deleted content is preserved in git
history — never a breadcrumb in the file.

Surviving structure (with clear `##` headings, critical content early):
- What keeper is / is NOT — one or two paragraphs, distilled from the current 420 lines.
- A compact system map: hook NDJSON append → events-log ingester → `events` table → reducer fold → projections → workers / UDS socket / autopilot. ~15 lines, prose or a small diagram (watch byte cost of box-drawing chars).
- Install/Uninstall — a few commands pointing at `install.sh`, PLUS the manual steps that have NO code home and would otherwise be lost: the launcher `plugin_scan_dirs` wiring for `~/code/keeper/plugins` (currently ~README:1828-1830) and the sitter-repo pointer (~README:660,1827). Keep only those; everything else in the 370-line Install section deletes.
- Lean `## Architecture` — ONLY current-behavior invariants an agent would get wrong that are NOT already in CLAUDE.md or a code comment. When in doubt, delete. The 2,380-line section has zero ### headings and interleaves subsystems mid-paragraph, so this is per-paragraph editorial judgment: for each paragraph ask (a) is this a live invariant or history/narrative? (b) is it already in CLAUDE.md rule form or a source docstring? Only a live invariant with no other home survives, compressed. Expect the survivors to fit in well under 100 lines.
- Lean `## Backup & restore` — a few lines pointing at the code-sourced runbook: `keeper reclaim --agent-help` and `src/backup.ts` `reclaimInstructions()`/`restoreInstructions()` (also emitted by `scripts/backup-db.ts`). Do NOT re-transcribe steps; code is the sole source of truth.

Delete wholesale: `## Example clients` (~1,015 lines), `## Inspect` (SQL recipes — the
keeper CLI subcommands cover the common cases), the bulk of `## Install`/`## Uninstall`,
and all past-tense fn-id/schema-version provenance everywhere in the file.

Repoint the cross-references in the same commit, reworded forward-facing (state what is,
never what was — no "formerly in README" tombstones):
- `src/backup.ts:743` + `:808` — drop the "AND in README `## Backup & restore`" mirror claim; the docstring becomes the sole source statement.
- `cli/reclaim.ts:33` — drop the README half; `keeper reclaim --agent-help` stays canonical.
- `cli/board.ts:126-131` — the comment/help points at the `keeper board` prose under `## Example clients` (deleted) and the --help text is circular (points back at README). Accepted content loss per the directive: make the comment/help self-contained in a couple of lines (pill/icon conventions get one sentence or nothing) and remove the README pointer.
- `src/usage-picker.ts:2` — "the README's data contract feeds" — restate self-contained (the agentusage envelope shape the picker consumes), no outward pointer.
- `src/db.ts:4868-4874` — the two reasons (converges + self-validating) are already inline in the comment; just delete the "named in the README prose" phrase.
- `CLAUDE.md:2` — rewrite the header sentence: rationale/history live in `.keeper/` specs and git history; README is a lean front door. `CLAUDE.md:116` — drop "+ README", keep `src/autopilot-worker.ts`. `CLAUDE.md:117` — drop "(see README)". CLAUDE.md is at 117/120 lines with content-fingerprint lint — edits must be net-neutral or trimming and stay lint-green.

Do NOT touch `.keeper/` specs' old README line-number citations (historical provenance),
and do NOT edit `plugins/plan/agents/docs-gap-scout.md` (generic, out of scope).

### Investigation targets

**Required** (read before coding):
- README.md — full read; headings at :3,:347,:426,:799,:1814,:1835,:4214,:4305
- CLAUDE.md:1-3,115-117 — the pointer lines to rewrite; whole file for what's already covered (the keep-bar comparator)
- src/backup.ts:740-820 — runbook docstrings + `reclaimInstructions`/`restoreInstructions`
- cli/board.ts:120-135 — the circular help/comment to make self-contained
- src/db.ts:4864-4874 — the inline-reasons comment

**Optional** (reference as needed):
- scripts/lint-claude-md.ts:66-102 — the content fingerprints CLAUDE.md edits must not trip
- install.sh — what Install steps are already automated (hence deletable)

### Risks

- The keep-bar is judgment over 2,380 unstructured lines — bias hard toward delete per the directive; a wrongly-deleted invariant is recoverable from git, a wrongly-kept pile defeats the epic.
- CLAUDE.md is 3 lines under its hard cap — verify `bun scripts/lint-claude-md.ts` green after edits.

### Test notes

`bun scripts/lint-claude-md.ts` green; `wc -l README.md` ≤250 and `wc -c README.md` ≤24576;
`rg -n 'README' src cli scripts` shows no reference to a deleted section; `bun test` green
(no test reads real README content — verified).

## Acceptance

- [ ] README.md ≤250 lines and ≤24576 bytes, structured with clear `##` headings
- [ ] `## Example clients` and `## Inspect` fully deleted; Install/Uninstall reduced to commands + the two manual no-code-home steps; Architecture reduced to no-other-home invariants; Backup & restore reduced to a code-runbook pointer
- [ ] No fn-ids, schema-version numbers, dates, or past-tense provenance anywhere in README.md
- [ ] All seven cross-reference sites reworded forward-facing with no README-section pointers to deleted content and no tombstones
- [ ] CLAUDE.md ≤120 lines and `bun scripts/lint-claude-md.ts` exits 0; `bun test` green

## Done summary
Gutted README from 4,466 to 121 lines / ~7KB (front door: what/is-NOT, compact system map, minimal install/uninstall incl. the two no-code-home manual steps, lean Architecture invariants, code-runbook backup pointer); deleted Example clients + Inspect + the Install/Architecture/Backup bulk. Repointed all seven code/CLAUDE.md cross-references forward-facing; CLAUDE.md stays 117 lines and lint-green.
## Evidence
