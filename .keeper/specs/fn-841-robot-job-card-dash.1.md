## Description

**Size:** M
**Files:** src/dash/view-model.ts, src/dash/theme.ts, test/dash-view-model.test.ts

Rewrite the pure dash view-model from the current `{ header, body[split|divider] }`
shape into a **card/band model** the OpenTUI paint layer (task `.2`) consumes.
This task is the keystone — it defines the card-model contract and the status
precedence ladder, and is fully fast-tier testable with NO `@opentui` import.

### Approach

- Replace `buildDashModel` output with a card model: `{ header, bands: Band[] }`
  where `Band = { key, title, cards: CardVM[] }` and each
  `CardVM = { key: "job:<id>", project, title, robotGlyph, railRole, statusWord,
  roleLabel, subagentCount, ageLabel, sessionLabel, isFocused, isTerminal }`.
  `header` carries the census line OR the connection-state string.
- **Status ladder, derived fresh** from `job.state` + the annotation columns
  (api-error → awaiting permission/input → working → ended → stopped → killed) —
  mirror the existing precedence in `buildJobRows` (`view-model.ts:574-586`). Do
  NOT reuse `rolledUpJobVerdict` (it only emits running/null and cannot express
  the six rungs). Each rung resolves to a robot codepoint + a rail role.
- **Dash-local robot map** (the six verified MDI codepoints), materialized with
  the same `cp()` pattern as `icon-theme.ts` (`String.fromCodePoint(parseInt(hex,16))`,
  which already handles 5-digit codepoints). Do NOT mutate `FA_CLASSIC` /
  `ACTIVE_THEME` — board/jobs keep `fa-classic`. A malformed/unknown `state`
  folds to a safe default rung (never throw).
- **Toggle gating:** add a `showTerminal` input flag; when false, drop
  ended/killed cards (default). When true, include them.
- **Bands + sort:** assign each card to needs-you (api-error|awaiting) /
  in-motion (working) / idle (stopped|ended|killed); stable `created_at` ASC
  within a band, `job_id` tiebreak. Empty bands carry no rule (the paint layer
  collapses them; the model simply emits an empty `cards` array).
- **Fields:** project via existing `projectBasename(cwd)`; title via `jobLabel`
  (never-blank); role via `planVerbLabel` (import from `src/board-render.ts` —
  `src/` may import `src/`, never `cli/`); subagent count by grouping the FLAT
  `subagentInvocations` on `job_id` filtered `status==="running"` (pattern at
  `view-model.ts:527-538`); session label from `backend_exec_session_id`/`_pane_id`;
  age from `created_at` vs injected `nowSec`.
- **Sanitize** `title`/`project`: strip `\x1b` (ESC) before they enter the model.
- Pure: `nowSec` injected (no `Date.now()`), no `@opentui` import, never throw.
- Drop the now-dead header inputs if unused (`autopilotRows`/`armedRows` and the
  forked `projectPaused`/`projectMode`/`projectArmed` projectors) — the census
  line needs none of them; confirm and remove, or keep only what the census reads.

### Investigation targets

**Required** (read before coding):
- src/dash/view-model.ts:521-598 — `buildJobRows`: job set, current sort, annotation precedence (the status-ladder source)
- src/dash/view-model.ts:387-499 — `projectBasename`, `jobLabel`, the running-subagent grouping
- src/dash/theme.ts:73-91 — `ROLE_COLORS` indices + `STRUCTURE_COLOR_INDEX=8`
- src/icon-theme.ts:183-212 — the `cp()` resolver + `glyphForToken` pattern (reuse semantics, add data dash-locally)
- src/types.ts:266-432 — `Job` fields: state, annotation columns, active_since, created_at, backend_exec_session_id/pane_id
- src/board-render.ts:84-90 — `planVerbLabel` (work→worker)
- test/dash-view-model.test.ts — the pure table-driven test harness + `makeJob`/`makeSnap` builders

**Optional** (reference as needed):
- src/readiness.ts (~1520) — `rolledUpJobVerdict` (reference for what NOT to reuse)
- src/collections.ts:127 — the `state not_in [ended,killed]` default scope the toggle relates to

### Risks

- The status ladder must stay consistent with `keeper jobs`' precedence — diverging hides a human-blocked or errored job.
- The card-model field names/types are the contract task `.2` depends on; get them right (a wrong shape propagates).

### Test notes

Pure table-driven tests in `test/dash-view-model.test.ts` (fast tier): each
ladder rung → correct robot codepoint + rail role; annotations outrank base
state (working+awaiting → confused/yellow); band assignment; stable intra-band
`created_at` sort; toggle gating (ended/killed hidden when off, shown when on);
census counts; ESC sanitization; never-throw on a malformed `state`. Assert the
`fa-classic` board/jobs glyph map is unchanged.

## Acceptance

- [ ] `buildDashModel(jobs, subagents, showTerminal, nowSec)` returns the `{ header, bands }` card model — pure, no `@opentui` import, no `Date.now()`
- [ ] The six-rung status ladder resolves each rung to the correct robot codepoint + rail role; annotations outrank base state
- [ ] `showTerminal=false` hides ended/killed; `true` includes them
- [ ] Cards banded (needs-you/in-motion/idle) with stable `created_at` sort; empty bands emit empty card arrays
- [ ] Robot map is dash-local — `FA_CLASSIC`/`ACTIVE_THEME` untouched; board/jobs glyph tests unchanged
- [ ] Malformed `state` folds to a safe rung (never throws)
- [ ] Pure tests cover ladder/bands/sort/toggle/sanitize/never-throw; fast `bun test` green

## Done summary

## Evidence
