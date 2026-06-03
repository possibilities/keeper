## Overview

Claude Code fires a `Notification` hook with `notification_type='permission_prompt'` when a session is parked on a tool-permission dialog (and `elicitation_dialog` when an MCP server requests input mid-tool-call). `plugin/hooks/events-writer.ts` already records both as `events.event_type`, but the reducer's `Notification` handling falls into the `default` no-op arm (`src/reducer.ts:6718`) — so the event lands in the immutable log and never projects onto `jobs`/`epics`. On the board such a worker renders as a plain `[working]` session with zero indication it is actually blocked waiting on the human. This epic folds those two notification subtypes into a new paired `(last_permission_prompt_at, last_permission_prompt_kind)` projection field — a near-exact clone of the schema-v25 `last_input_request_*` / `[awaiting:ask_user_question]` machinery — denormalized onto `job_links` + embedded jobs, rendered as `[awaiting:permission]` / `[awaiting:elicitation]` pills that layer on top of the `[working]` state. End state: a permission- or elicitation-parked worker is visibly flagged on `keeper board` so the human knows to act.

## Quick commands

- `bun test test/reducer.test.ts test/board.test.ts test/db.test.ts test/schema-version.test.ts` — the four suites this change extends
- `bun test` — full suite (re-fold determinism + migration)
- Smoke: with the daemon running, trigger a real permission dialog in any Claude Code session, then watch `keeper board` render `[awaiting:permission]` on that worker; approve the dialog and watch it clear on the next `PostToolUse`.

## Acceptance

- [ ] A `permission_prompt` Notification event stamps `(last_permission_prompt_at, last_permission_prompt_kind='permission')`; an `elicitation_dialog` event stamps `kind='elicitation'`; the board renders the matching `[awaiting:<kind>]` pill on its own continuation line, layered on the `[working]` state.
- [ ] `idle_prompt` / `auth_success` / any other `notification_type` does NOT stamp.
- [ ] The pair clears on `UserPromptSubmit` / `SessionStart` / `PreToolUse` / `PostToolUse` / `Stop`; the stamp does NOT flip `state`.
- [ ] `SCHEMA_VERSION` bumped to 52, `52` added to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`, `test/schema-version.test.ts` passes.
- [ ] A from-scratch `cursor=0` rewind-and-redrain reproduces byte-identical projections (the new pair is a pure function of `event.ts`).

## Early proof point

Task that proves the approach: `permission-prompt-awaiting-pill.1`. If it fails (the rewind over historical `permission_prompt` rows breaks re-fold determinism, or the paired-NULL invariant drifts across the five JSON/row shapes): fall back to splitting the migration/projection layer from the render layer into two tasks and land the columns first.

## References

- This is a faithful clone of schema v25 (`InputRequest` / `last_input_request_*`). The one structural divergence: `permission_prompt` / `elicitation_dialog` are REAL `Notification` hook events keyed by `events.event_type`, NOT synthetic events — so the fold logic lives in a new `case "Notification"` branching on `event_type`, never a new synthetic mint.
- `fn-684` (zellij event bridge) overlaps on `src/reducer.ts` + `src/db.ts`; its note: "if either side bumps, second-to-land rebases the version number." Wired as an overlap-coordination dep (see Phase 6) — unwire with `planctl epic rm-dep` if you want them parallel.
- No "permission dialog dismissed" hook exists (anthropics/claude-code#19628, closed not-planned) — clearing MUST be inferred from the next downstream event. The Notification payload carries no `tool_name` (#32952), so the pill cannot name which tool is blocked; `[awaiting:permission]` with no tool detail is the accepted ceiling.

## Docs gaps

- **README.md**: lines 18-28 (two→three paired stoppage annotations), 549-553 (board pill enumeration — add `[awaiting:permission]`/`[awaiting:elicitation]`, note hook-sourced not synthetic), 826-832 (transcript-worker synthetic-event paragraph — contrast the real-hook permission fold), 1282-1300 + SQL snippets 1552-1554 / 1587-1589 (job_links denorm field list).
- **CLAUDE.md / AGENTS.md**: the `Notification` event is now folded (no longer a pure no-op) — update the event-sourcing prose if it asserts Notification is inert; the sole-writer synthetic list needs NO change (this is a hook-event fold, not a new synthetic).
- **cli/board.ts HELP string** (165-186) + **src/board-render.ts** `inputRequestPillSeg` JSDoc + `PILL_COLORS` example list: list the new awaiting kinds, distinguish hook-fired from transcript-derived, advance the schema-version callout.

## Best practices

- **Clear on `PostToolUse`, never on `UserPromptSubmit` alone** [anthropics/claude-code#19628]: `PostToolUse` is the highest-fidelity clear (logically cannot fire while the dialog is open). The cloned set fires `PreToolUse`/`PostToolUse` before any false-positive window, so the proven `input_request` clear set is safe; `Stop` is the session-level backstop.
- **Do NOT clear on `idle_prompt`** [practice-scout]: a session can idle WHILE the dialog is open — treating idle as a clear is a false negative. The design satisfies this by construction (only `permission_prompt`/`elicitation_dialog` stamp; clears live off the Notification arm entirely).
- **Timestamp pair, not a boolean** [event-sourcing]: the nullable `_at` makes the fold a pure monotone function of `event.ts`, so a re-fold from cursor=0 reproduces identical rows. Treat a second `permission_prompt` on the same session as a re-set (re-write `_at`), not an increment.
- **`PermissionDenied` deliberately excluded**: it has no existing reducer arm and it is unverified whether it fires on human-initiated denials — not relied on as a clear signal.
