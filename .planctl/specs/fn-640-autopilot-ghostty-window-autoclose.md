## Overview

Make autopilot's Ghostty launch shell-agnostic and self-cleaning: launch
claude through `$SHELL` (validated, `/bin/zsh` fallback) with an
interactive-shell fallback, capture the spawned window's stable id, and
auto-close that exact window when keeper marks the dispatch complete —
reaping claude + shell + window together. The interactive shell is a
manual-intervention fallback (ctrl+z out of claude → shell → vim) for the
uncommon case where auto-close does not fire; it is not a competing
feature. All changes are client-side in `scripts/autopilot.ts` (NOT the
reducer) — `dispatch.log` is a forensic append-only audit log, so the new
`window` kind inherits the relaxed "malformed lines skip silently" contract.

## Quick commands

- `bun test --isolate test/autopilot.test.ts`  # hydrate fold + close-trigger via injected deps
- `bun run lint && bun run typecheck`

## Acceptance

- [ ] worker command wrapped as `${shell} -l -i -c '<cmd> ; exec ${shell} -l -i'`, shell = validated `process.env.SHELL` ?? `/bin/zsh`
- [ ] spawned Ghostty window id captured from osascript stdout (isolated from the yabai tail) and persisted as a new dispatch.log `window` kind
- [ ] windowId stamped onto the live in-memory `DispatchEntry` AND folded onto restored entries by `hydrateDispatchLog`
- [ ] `detectJobTransitions` calls `closeWindow(entry.windowId)` at both `completedKeys`-entry sites, once per key
- [ ] `closeWindow` uses the verified repeat-loop close pattern; no-ops on undefined/stale id and under dry-run
- [ ] JSDoc + HELP updated in lockstep to four kinds

## Early proof point

Task that proves the approach: `.1`. If it fails: fall back to a manual
operator `--close <verb::id>` path keyed off the persisted windowId, leaving
auto-close out.

## References

- `/Applications/Ghostty.app/Contents/Resources/Ghostty.sdef` — `window.id` (text, :43), `close window` responds-to (:53), `new window` returns `window` (:169-174)
- practice-scout (live-tested): close via repeat-loop (`if id of w is wid then close window w`); `close window id "..."` errors -2741 (text-vs-integer specifier); window ids stable across separate osascript processes; closing the window SIGHUPs the shell process-group leader and reaps claude+children
- practice-scout (live-tested): zsh `exec_opt` is OFF under `-i`, so `zsh -l -i -c 'claude'` keeps zsh as parent and claude as child

## Docs gaps

- **scripts/autopilot.ts JSDoc (lines 1–150)**: add the `window` kind to the three-kind enumeration; revise the `launchInGhostty` edge-trigger narrative for `$SHELL` + window-id capture; add an auto-close sentence to the `detectJobTransitions` `completedKeys` paragraph
- **scripts/autopilot.ts HELP (lines 153–250)**: "carries three kinds" → four kinds; `--dry-run` "skip the Ghostty spawn" → generalized `$SHELL` phrasing; edit in lockstep with the JSDoc (word-for-word on kind-field descriptions)
- **README.md autopilot.ts description (lines 464–485)**: tighten-and-correct the stale two-block description; reflect the generalized shell launch; keep at one-paragraph altitude

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/autopilot-ghostty-window-autoclose` — the `/arthack:sketch` handoff bundle (no snippets curated)
