## Description

**Size:** M
**Files:** a new keeper prompt corpus snippet (orient), plugins/keeper/skills/{await,autopilot,dispatch,handoff}/SKILL.md, README.md (`## Example clients`)

Make the new surface holistically useful: a shared "orient-first" step and
the new commands/conditions documented where agents will look.

### Approach

Author a shared "orient" snippet in the `keeper prompt` corpus (engineering/
namespace) with the literal `keeper status --json` command embedded; reference
it via the prompt plugin's include mechanism (check
`plugins/prompt/src/render_engine.ts` for `{% include %}` vs a
`keeper prompt render engineering/<name>` citation — match the existing
precedent in `plugins/plan/skills/hack/SKILL.md`, with a `<!-- Canonical
source: ... -->` drift-guard). It is a snippet, NOT a new skill (orientation
is a step inside action skills).

Thread orient→decide→act→await into `dispatch` (consolidate the scattered
`keeper plan show` verify-on-board checks ~:91-108 into one orient block
before Step 1) and `autopilot` (repoint the `--snapshot | tail -1` reads at
:72/:88/:130/:150 to `keeper status --json`; update the `keeper-meta:` trailer
example ~:96 and the `{paused, mode, armed, worktree_mode}` capture set
lines 7/133 to the extended shape); add a light orient to `handoff` (promote
the `keeper board` inspect note ~:132). Expand `await`'s condition table with
`drained`/`epic-added`/`epic-removed`/`changed`; revise the `complete` row to
done-AND-idle (note the stale-subagent behavior change); add board-discovery
guidance (point at `keeper status` — today it only verifies a known id); add
the armed-line field-shape rows for the new conditions; trim its repetition
(heaviest keeper skill at 370 lines). Surface the audit gaps: add
`keeper autopilot config` (max_concurrent_jobs/per_root) to the autopilot
skill; point hack's forensics recipes at the JSON subcommands (search-history/
show-session-events/show-job/find-file-history) instead of raw sqlite.
Update README `## Example clients` (~771-1494): new `status`/`query`/`watch`
bullets in the established shape, revised await enumeration, extended
`subscribeReadiness` field prose. Forward-facing prose only (no fn-ids/dates).

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md (condition table, armed-line shape ~:194-212, length)
- plugins/keeper/skills/autopilot/SKILL.md (:7, :72, :88, :96, :130, :133, :150)
- plugins/keeper/skills/dispatch/SKILL.md (~:91-108 verify-on-board), handoff/SKILL.md (~:132)
- plugins/prompt/src/render_engine.ts — the include/render mechanism for the shared snippet
- plugins/plan/skills/hack/SKILL.md — the `<!-- Canonical source -->` snippet-citation precedent
- README.md ~771-1494 (`## Example clients`)

**Optional:**
- bun scripts/lint-claude-md.ts — keep CLAUDE.md green if touched (it should NOT need touching)

### Risks

- Don't duplicate the orient snippet body inline across four skills — reference it once.
- Forward-facing-only rule: state current behavior, no provenance/version narration.

### Test notes

Prose/docs task — verify by rendering the orient snippet (`keeper prompt render <ns>/orient`) and confirming each skill references rather than inlines it. No code tests beyond keeping the suite green.

## Acceptance

- [ ] A shared orient snippet exists in the prompt corpus and is referenced (not inlined) by await/autopilot/dispatch/handoff.
- [ ] autopilot/dispatch repointed off TUI `--snapshot` to `keeper status`; autopilot snapshot examples reflect the extended shape.
- [ ] await skill documents `drained`/`epic-added`/`epic-removed`/`changed`, the tightened `complete` (+ stale-subagent note), and board-discovery; repetition trimmed.
- [ ] `keeper autopilot config` surfaced; hack forensics point at the JSON subcommands.
- [ ] README `## Example clients` covers `status`/`query`/`watch` and the revised await set.
- [ ] Forward-facing prose only; `bun scripts/lint-claude-md.ts` green.

## Done summary

## Evidence
