## Overview

Replace the `keeper dash` screen (today: header strip + PLAN + AGENTS list)
with a live, read-only, full-screen **single column of compact cards — one
per job**, showing project name · job title · status. Status is dual-encoded
as a Nerd Font **md-robot face** plus a colored left rail, so the board is
calm when idle and the few jobs that need attention pop. Read-only and
TTY-only end to end — no schema, RPC, migration, or producer changes; a pure
new consumer of the existing `jobs` projection via `subscribeReadiness`.

The robot status ladder (annotations outrank base state):

| priority | condition | robot (nf md) | codepoint | rail color (ANSI idx) |
|---|---|---|---|---|
| 1 | `last_api_error_at` set | robot_angry | `f169d` | red (1) |
| 2 | awaiting input/permission | robot_confused | `f169f` | yellow (3) |
| 3 | `state = working` | robot | `f06a9` | blue (12) |
| 4 | `state = ended` | robot_happy | `f1719` | green (2) dim |
| 5 | `state = stopped` | robot_outline | `f167a` | gray (7) dim |
| 6 | `state = killed` | robot_dead | `f16a1` | red (1) dim |

Cards group into three urgency bands (needs-you / in-motion / idle) with dim
section rules; within a band, stable `created_at` order so live cards never
teleport on metadata ticks. The border is ALWAYS structure-gray (OpenTUI 0.3.0
has no `titleColor`, so the project name in the border inherits border color —
status color lives only in the rail). A `j`/`k` focus cursor (keyed on
`job_id`) swaps the focused card to a heavy cyan border. Ended/killed jobs are
hidden by default (matching `keeper jobs`, whose feed excludes terminal states
— `src/collections.ts:127`) and revealed via a keybind toggle.

## Quick commands

- `bun run cli/keeper.ts dash` — launch the live screen on a TTY (no snapshot mode; a pipe exits 1)
- `bun run test:opentui` — the dash frame/shell + view-model tests
- `bun run test:full` — mandatory before landing (covers the slow/opentui tiers)

## Acceptance

- [ ] `keeper dash` renders one robot-faced card per live job (project · title · status), single column, three urgency bands
- [ ] Status dual-encoded: a md-robot face + a left rail color per the six-rung ladder; border always structure-gray
- [ ] `j`/`k`/arrows drive a per-card focus cursor keyed on `job_id` (survives re-sort); focused card shows a heavy cyan border
- [ ] A keybind toggles ended/killed visibility; default OFF (live-only); ON reveals the happy/dead robots
- [ ] Read-only / TTY-only / teardown invariants preserved (no DB, no RPC, destroy-before-exit); board/jobs `fa-classic` theme untouched
- [ ] `bun run test:full` green; a ~25-job screenshot reads calm (idle cards recede)

## Early proof point

Task that proves the approach: `.1` (the pure view-model + robot status ladder).
It defines the card-model contract the paint layer consumes and is fully
fast-tier testable. If it fails: the model shape / status precedence is wrong —
fix it before building the OpenTUI paint layer on top.

## References

- Design vetted by an opus4.8-gpt5.5 panel (single column, rail-as-status-channel, warm-in-cool, robots dash-only).
- `~/docs/keeper-tui-icon-sets.md` — the themeable state→glyph form; `~/docs/pill-inventory.md` — pill vocabulary.
- md-robot codepoints verified present in the user's JetBrainsMono Nerd Font (authoritative: nerd-fonts `bin/scripts/lib/i_md.sh`).
- Reuse: `src/dash/view-model.ts` `buildJobRows`/`projectBasename`/`jobLabel`; `src/icon-theme.ts` `cp()`; `src/board-render.ts` `planVerbLabel`; `src/dash/theme.ts` role indices.

## Docs gaps

- **README.md** (dash bullet ~1025-1068): full rewrite — the header+PLAN+AGENTS layout is obsolete; describe the single-column card screen + the toggle.
- **README.md** (`active_since` note ~1876-1886): prune/relabel the dash-specific "AGENTS unified timeline" framing to "job-card order".
- **cli/dash.ts**: `HELP` constant (line 24) + module docstring — replace "header + PLAN + AGENTS" with the card screen + keybinds.
- **src/dash/{view-model,theme,app}.ts**: module docstrings — card-model shape, dash-local robot map, scene tree + subscription wiring.
- **~/docs/keeper-tui-icon-sets.md**: note the dash carries its own parallel md-robot map (dash-local), not routed through the shared `ACTIVE_THEME`.

## Best practices

- **Mutate cards in place, never add/remove per frame:** add/remove rebuilds the Yoga tree and forces a full ScrollBox re-layout; keep one BoxRenderable per `job_id` and mutate `borderColor`/`borderStyle`/child Text content. [practice-scout: opentui-030]
- **No `live:true` on idle cards:** it puts each card in a per-frame onUpdate loop; push updates from the subscription edge instead. [opentui-030]
- **Nerd Font Mono, single-cell:** place the robot glyph in its own Yoga slot + trailing space; the non-Mono variant bleeds into the border and corrupts the frame diff. Some macOS libc reports `wcswidth=2` for high-PUA — don't compute glyph width in JS. [nerd-fonts#940, nnn#1802]
- **`RGBA.fromIndex` for the rail/idle, not hex:** indexed colors track the terminal theme (light/dark); pick indices that differ in lightness (1/3/12) so status survives grayscale + color-deficiency. [WCAG SC 1.4.1]
- **Sanitize socket strings:** strip `\x1b` from job title / project before `TextRenderable.content` (OSC/DCS injection risk from untrusted event data). [practice-scout: Security]
- **`scrollChildIntoView` for the focus cursor:** nearest-edge, no-op if already visible — avoids scroll jitter on key repeat. [opentui-015]
