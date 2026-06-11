## Description

**Size:** M
**Files:** src/dash/theme.ts, src/dash/view-model.ts, test/dash-view-model.test.ts

### Approach

Pure, OpenTUI-free modules — the design layer of the dash. `theme.ts`
maps the six semantic roles {motion, ready, attention, failed, terminal,
accent} to ANSI-indexed color descriptors (plain data: index + optional
dim flag — NO RGBA, NO @opentui import; the materializer converts via
RGBA.fromIndex in task .2), forked from board-render's bucket semantics
(blue=motion, green=ready, yellow=attention, red=failed, dim=terminal,
cyan=accent). `view-model.ts` exposes one entry —
`buildDashModel({snapshot, autopilotRows, armedRows, connection, nowSec})`
→ typed `{header, plan: PlanRow[], agents: AgentRow[], placeholders}`
where every row is a list of `{text, role}` segments the materializer
renders verbatim. Fork the three tiny autopilot projectors
(projectAutopilotPaused/Mode/ArmedEpics) into this module — src never
imports from cli/. Glyphs resolve via `glyphForToken`/`FA_CLASSIC`
(import as-is), with a text fallback when it returns null.

Settled semantics to encode (each is a test case):
- Header: `▶/⏸ autopilot · <mode> · N armed`; empty-armed-in-armed-mode
  renders distinctly (mirror the existing `nothing armed`); dead-letter
  segment from snapshot.deadLetters.length only when > 0; seed state
  before the autopilot_state first edge mirrors cli/autopilot.ts.
- PLAN: one row per epic in SERVER order (sort_path ASC — no client
  re-sort); epic_number/title with epic_id fallback when both null;
  per-epic verdict glyph + word from readiness.perEpic (map miss renders
  the blocked/unknown form — visible bug indicator, mirroring board);
  blocked reason inline in terminal/dim role; N/M from readiness.perTask
  counting ONLY tag==="completed" (miss = not done), segment hidden when
  the epic has zero tasks; armed marker (accent role) when epic_id is in
  the armed set.
- AGENTS: working jobs PLUS stopped-but-needs-you (any non-null
  last_input_request_at / last_permission_prompt_at / last_api_error_at).
  NEVER drop a needs-you row: label coalesces title → plan_ref → job_id;
  role glyph from plan_verb with a generic session glyph fallback on
  null/unknown verb. Sort: needs-you first, then working; within each
  group created_at ASC, job_id ASC tiebreak. Elapsed from updated_at vs
  nowSec, compact fixed-width bands (5s/4m/2h/1d — floor to largest unit,
  no "ago"); awaiting (attention role) / failed (failed role) annotation
  replaces elapsed when present.
- Connection: a ConnectionState input ("connecting" | "live" |
  "reconnecting") yields the pre-paint `waiting for keeperd…` body line
  and the post-paint header marker; loaded-empty sections render dim
  placeholders (`no open epics` / `no agents`) distinguishable from
  connecting.

### Investigation targets

**Required** (read before coding):
- src/readiness-client.ts:231-245 — ReadinessClientSnapshot shape (epics,
  jobs Map, deadLetters, readiness.perEpic/perTask Verdict maps)
- src/readiness.ts:340-344 — the Verdict union this consumes
- cli/autopilot.ts:339-411 — the three projectors to fork (empty/boot-race
  handling); :741-759 — banner assembly to mirror; :277-307 —
  buildCurrentRows as the AGENTS projector template (broaden, don't reuse:
  it DROPS null-verb/empty-plan_ref rows that AGENTS must keep)
- src/icon-theme.ts:89,193 — FA_CLASSIC + glyphForToken(token) → string|null
- src/board-render.ts:399-463 — the SGR buckets + PILL_COLORS semantics
  being forked into theme roles
- src/types.ts:434 (Job: state, plan_verb, plan_ref, title, created_at,
  updated_at, the three needs-you pairs), :1042 (Epic: epic_number, title,
  epic_id, tasks)

**Optional** (reference as needed):
- ~/resources/tui/pi-tools/skills/pi-tui-design/SKILL.md — terminal design
  vocabulary (read for craft, never copy its pi-tui API patterns)
- test/board.test.ts — table-driven render-assertion style to mirror

### Risks

- The segment vocabulary is the contract task .2 materializes — keep roles
  semantic (motion/ready/attention/failed/terminal/accent), never
  widget-specific, or the theme fork loses its meaning.
- Nerd Font PUA glyphs are width-1 by wcwidth; column budgets assume one
  cell per glyph (extra padding space is the escape hatch).

### Test notes

Fast-tier `bun test test/dash-view-model.test.ts` — pure table-driven
cases over hand-built snapshots; no subprocess, no sandboxEnv, no
@opentui import anywhere in the new files (that property keeps the file
out of the slow tier — assert it stays true in review).

## Acceptance

- [ ] theme.ts maps the six semantic roles to ANSI-indexed descriptors as
      plain data; no @opentui import in any new file
- [ ] buildDashModel covers: header permutations (paused/playing ×
      yolo/armed × N armed incl. nothing-armed; dead-letter segment only
      when > 0), PLAN rows (server order kept; null-title/number fallback;
      verdict glyph+word incl. map-miss; N/M completed-only with miss=not-done
      and zero-task hide; armed marker), AGENTS rows (needs-you inclusion
      and never-drop with label coalescing; null-verb glyph fallback;
      needs-you-first sort with created_at/job_id tiebreak; elapsed bands;
      awaiting/failed annotation replacing elapsed), connection states and
      empty-state placeholders
- [ ] all tests run in the default fast tier and pass

## Done summary
Added the pure, OpenTUI-free dash design layer: src/dash/theme.ts maps the six semantic roles to ANSI-indexed descriptors, and src/dash/view-model.ts's buildDashModel folds a readiness snapshot plus the autopilot side-streams into role-tagged segment rows (header/PLAN/AGENTS), forking the three autopilot projectors so src never imports cli. Fast-tier table-driven tests cover every settled semantic.
## Evidence
