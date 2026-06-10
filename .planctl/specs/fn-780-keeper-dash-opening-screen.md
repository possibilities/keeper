## Overview

`keeper dash` — v1 of the unified keeper TUI: a minimal, read-only opening
screen that answers "what is going on plan/work/agent-wise" in one place,
unifying the at-a-glance value of `keeper board` + `keeper jobs` +
`keeper autopilot`. Additive (existing viewers stay); the seed of a future
unified app shell (shell itself out of scope). Fresh `@opentui/core` 0.3.0
component app under `src/dash/` — pure view-model builders + a thin
renderable materializer; imports the readiness-client data layer and
icon-theme as-is; forks color semantics and the fn-723 exit-trigger set;
leaves view-shell/live-shell/sidecars/pill convention behind. TTY-only
(no snapshot mode — settled), read-only (no RPC, no DB open).

Settled semantics: reconnect-forever with connection state shown in-TUI;
PLAN N/M counts only completed perTask verdicts (miss = not done, hidden at
zero tasks); AGENTS = working + stopped-but-needs-you (never drops a
needs-you row; label title→plan_ref→job_id); PLAN in server sort_path
order; AGENTS needs-you-first then created_at ASC, job_id tiebreak;
ANSI-indexed colors (theme-tracking, matches board hues); one coarse 30s
elapsed repaint interval.

## Quick commands

- `keeper dash` — live screen on a TTY (header strip + PLAN + AGENTS)
- `echo | keeper dash` — must print `keeper dash: requires a TTY` and exit 1
- `bun test test/dash-view-model.test.ts` — fast-tier view-model suite
- `bun run test:full` — the landing gate (CLI/process paths touched)

## Acceptance

- [ ] `keeper dash` on a TTY renders the three regions live over the UDS
      subscribe socket and repaints on data edges
- [ ] TTY-only gate before any OpenTUI import; read-only end to end
- [ ] no exit path (q, Ctrl-C, SIGHUP, stdin-EOF, ppid-poll, onFatal,
      uncaught) leaves the terminal stranded in alt-screen/raw mode
- [ ] daemon-down and mid-session disconnect are visible in the TUI, and
      reconnect repaints without restart
- [ ] pure view-model tests ride the default fast tier; the OpenTUI frame
      test rides the serial-safe test:opentui chain
- [ ] docs updated: `cli/keeper.ts` usage block (five-viewer sentence
      restructured for the TTY-only dash), README example clients

## Early proof point

Task that proves the approach: `.2` (fresh-OpenTUI app lifecycle is the
keystone risk). If it fails: fall back to the absolute-positioned
TextRenderable vocabulary already proven in `src/live-shell.ts:512-573`,
keeping `.1`'s view-models unchanged.

## References

- `~/resources/tui/INDEX.md` — TUI resource router; OpenTUI docs clone at
  `~/resources/tui/opentui/packages/web/src/content/docs/` (keeper pins
  `@opentui/core` 0.3.0 — trust installed package types on any mismatch)
- `cli/autopilot.ts:339-411` — projectAutopilotPaused/Mode/ArmedEpics, the
  pure projectors `.1` forks (src must not import from cli); `:741-759`
  banner label convention; `:277-307` AGENTS projector template
- `src/readiness-client.ts` — subscribeReadiness/subscribeCollection; the
  readiness conn internally subscribes autopilot_state/armed_epics but does
  NOT expose them on the snapshot — the two extra subscribeCollection subs
  are required for the header
- `fn-778-subscribed-ghost-eviction-and-dup-close` (wired dep) — peer-liveness
  eviction + max_connections backoff for exactly the long-lived subscribe
  connections dash opens; dash works without it (same behavior as today's
  viewers) but should land after to avoid adding one more cap-hammering client
- fn-779 (no relationship) — passive display benefit only: more accurate
  completed-verdict timing

## Docs gaps

- **cli/keeper.ts**: USAGE block — add `dash` row; restructure the "five
  viewer subcommands … auto-detect a non-TTY stdout" sentence so dash is
  carved out as TTY-only (don't silently bump five→six)
- **README.md**: "Example clients" enumeration (~573) + the "All five
  viewers … three-way TTY gate" paragraph (~605) — scope to the
  snapshot-capable set, add a `dash.ts` bullet in the per-viewer series
  (~632): data sources, frame shape, TTY-only

## Best practices

- **destroy before exit:** OpenTUI does not auto-restore the terminal on
  process.exit/uncaught — every exit path must renderer.destroy() first [opentui lifecycle doc]
- **reactive render mode:** never call renderer.start(); mutate renderables
  and let OpenTUI repaint on change — 0 CPU idle [opentui renderer doc]
- **stable tree + setContent:** construct the renderable tree once; diff row
  content into existing TextRenderables; structural add/remove only on row-count
  change (Yoga recalc rides structure, not content) [opentui gotchas]
- **ScrollBox needs focus + explicit height chain:** scrollbox.focus() or
  j/k/arrows are silently dead; root Box 100%/100% column, header fixed,
  body flexGrow:1; viewportCulling:true for long lists [opentui scrollbox doc]
- **truncate in JS, not at the cell boundary:** Text neither wraps nor
  truncates; renderer clipping breaks multi-byte glyphs — budget columns and
  truncate before setContent; Nerd Font PUA glyphs count as width 1 [opentui gotchas]
- **indexed colors track the user's theme:** RGBA.fromIndex keeps dim/semantic
  hues legible on light terminals; don't mix with hex strategies [opentui colors doc]
- **one elapsed interval for N rows**, cleared on destroy; no console.log
  while the renderer is active [opentui gotchas]
