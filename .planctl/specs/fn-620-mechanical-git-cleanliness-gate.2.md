## Description

**Size:** S
**Files:** apps/planctl/skills/approve/SKILL.md, apps/planctl/skills/approve/scripts/render-context.ts, apps/planctl/skills/approve/scripts/render-context.test.ts

### Approach

Task .1's mechanical gate in keeper's readiness pipeline makes Rules 1 (uncommitted) and 2 (orphans) of the /plan:approve skill cascade redundant — those checks fire mechanically before the approve session is even dispatched. Trim the skill and its substrate to a two-rule cascade (Rule 0: keeperd unavailable; Rule 1: needs-human signal in last assistant message, formerly Rule 3).

In SKILL.md: delete the Rule 1 and Rule 2 H3 blocks entirely. Renumber Rule 3 → Rule 1 (the renamed block keeps its body verbatim — just the heading number changes). Update the Phase 3 section header from "Four-rule cascade (first match wins)" to "Two-rule cascade (first match wins)". Update front-matter `description` (line 5) and Phase 3 intro prose (line ~17, "Lean toward approve" paragraph) to drop the "uncommitted/orphan/needs-human" enumeration and reference only needs-human.

In render-context.ts: delete the third keeperd round-trip (the `git` collection query at ~lines 552-594), the `renderFileList` helper, the `GitFile` and per-job `GitJob` interfaces (lines ~129-150) if unused after the round-trip removal, and the two `renderFileList(...)` invocations that emit `## uncommitted job work` and `## orphan files` headings (~lines 622-623). Update the top-of-file docstring (lines 9-34) to describe the two-rule cascade — rewrite the "What the four-rule cascade reads" section.

Minimize the `renderKeeperdUnavailable` envelope (lines ~635-659) to just the heading and detail line — drop the four-line explanatory prose that mentions "uncommitted/orphan/needs-human signals" and the four-rule cascade. The new shape:

```
# planctl approve context — `<id>`

| key | value |
|---|---|
| id | <id> |
| kind | <kind> |

## ERROR: keeperd unavailable

Detail: <error>
```

In render-context.test.ts: delete the `renderFileList` describe block (around line 162+), the "task with dirty" / "dirty job work" tests (around line 459+), the "epic with orphans" tests (around line 523+), and the keeperd-down test's negative assertions that check for `## uncommitted job work` / `## orphan files` headings (the headings no longer exist; the test should still assert the trimmed envelope shape — heading + detail line — and may need rewriting rather than just deletion).

### Investigation targets

**Required** (read before coding):
- apps/planctl/skills/approve/SKILL.md:5 — front-matter `description` field
- apps/planctl/skills/approve/SKILL.md:17-31 — Phase 3 intro prose ("Lean toward approve" paragraph)
- apps/planctl/skills/approve/SKILL.md:72-105 — Rule 1 + Rule 2 H3 blocks to delete
- apps/planctl/skills/approve/SKILL.md:107-148 — Rule 3 H3 block (becomes Rule 1)
- apps/planctl/skills/approve/SKILL.md:150-152 — "No match through all rules" paragraph
- apps/planctl/skills/approve/scripts/render-context.ts:1-34 — top-of-file docstring (rewrite)
- apps/planctl/skills/approve/scripts/render-context.ts:129-150 — `GitFile` / `GitJob` interfaces
- apps/planctl/skills/approve/scripts/render-context.ts:349-355 — `renderFileList` helper
- apps/planctl/skills/approve/scripts/render-context.ts:552-594 — round-trip 3 (the `git` collection query block)
- apps/planctl/skills/approve/scripts/render-context.ts:620-625 — the two `renderFileList` invocations
- apps/planctl/skills/approve/scripts/render-context.ts:635-659 — `renderKeeperdUnavailable` (minimize)
- apps/planctl/skills/approve/scripts/render-context.test.ts — locate and delete tests around dirty-job / orphans / renderFileList; rewrite keeperd-down test's assertions

**Optional** (reference as needed):
- apps/planctl/skills/approve/scripts/render-context.ts:42-46 — Transcript-injection guard comment (unaffected; keep)

### Risks

- **render-context.test.ts breakage.** Tests around the deleted code paths need surgical removal, not blanket deletion — the file may have shared setup, fixtures, or imports that other tests still depend on. After the trim, `bun test apps/planctl/skills/approve/scripts/render-context.test.ts` must pass.
- **Stale prose hiding outside the deleted blocks.** Inline comments inside render-context.ts may reference "four-rule cascade" or "uncommitted/orphan" outside the listed line ranges; grep the file before declaring done.
- **The skill's `description:` front-matter feeds skill discovery.** Keep it readable as a one-liner; don't truncate to the point that future readers wonder what the skill does.

### Test notes

- `bun test apps/planctl/skills/approve/scripts/render-context.test.ts` passes after the trim.
- `grep -rn "four-rule\|uncommitted job work\|orphan files" apps/planctl/skills/approve/` returns no surviving matches.
- Manual smoke after task .1 is in place: `/plan:approve <task_id>` against a clean tree approves; against a dirty tree, the mechanical gate from task .1 blocks the autopilot dispatch and `/plan:approve` is never opened. (Not automated.)

## Acceptance

- [ ] SKILL.md cascade trimmed to Rule 0 (keeperd unavailable) + Rule 1 (needs-human signal, formerly Rule 3); section header "Four-rule cascade" → "Two-rule cascade"; "No match through all rules" paragraph still reads cleanly
- [ ] SKILL.md front-matter `description` and Phase 3 intro prose drop "uncommitted/orphan" — reference only needs-human
- [ ] render-context.ts: round-trip 3 deleted; `renderFileList` helper deleted; `GitFile` / `GitJob` interfaces deleted if unused; the two `renderFileList` invocations deleted; top-of-file docstring rewritten to describe two-rule cascade
- [ ] render-context.ts `renderKeeperdUnavailable` minimized to heading + detail line (no four-rule cascade prose)
- [ ] render-context.test.ts: dirty-job tests, orphans tests, `renderFileList` describe block deleted; keeperd-down test's assertions updated to match the minimized envelope shape
- [ ] `grep -rn "four-rule\|uncommitted job work\|orphan files" apps/planctl/skills/approve/` returns no surviving matches
- [ ] `bun test apps/planctl/skills/approve/scripts/render-context.test.ts` passes; no regressions in other arthack test files

## Done summary

## Evidence
