## Overview

Autopilot parks sticky `dispatch_failures` rows when a dispatch can't proceed
(merge conflict, multi-repo gate, dirty checkout, non-fast-forward). Today the
affected board row still reads `[ready]` — the block reason is buried in a table
nobody watches, so a wedged autopilot looks idle. This epic overlays the sticky
reason as a red `[failed:<short-kind>]` pill on the board TUI and an additive
`dispatch_failure: string[]` field in the `keeper status` JSON, via one shared
pure classifier + key→target resolver. Render-layer only: no change to
`computeReadiness`, the reconciler, `await-conditions`, folds, schema, or the RPC
protocol.

Two verified gaps close here:
- **Gap A** — `cli/board.ts` keys its close-failure map by raw `dispatch_failures.id`
  and looks it up by exact epic id, so worktree-mode keys
  (`close::worktree-finalize:<epic>-<hash>` / `worktree-recover:...`) never match and
  finalize/recover conflicts render no pill.
- **Gap B** — the builder skips every non-`close` row, so `work::<task_id>` failures
  (e.g. `worktree-multi-repo`) show no pill and the task looks dispatchable.

## Quick commands

- `bun test test/board.test.ts test/status.test.ts` — pill + envelope string assertions
- `bun test test/dispatch-failure-pill.test.ts` — new classifier + resolver unit suite
- `keeper status --json | jq '.data.board.epics[].tasks[].dispatch_failure, .data.board.epics[].close.dispatch_failure'` — smoke the new field
- `bun run typecheck && bunx biome check` — types + lint clean

## Acceptance

- [ ] A worktree-mode finalize/recover conflict renders `[failed:merge-conflict]` on the epic close row (Gap A closed).
- [ ] A `work::`-blocked ready task renders `[ready] [failed:multi-repo]` inline (Gap B closed).
- [ ] `keeper status` emits `dispatch_failure: string[]` on task + close views; `STATUS_SCHEMA_VERSION` bumped 1→2 in the same change.
- [ ] The classifier never throws and never emits a bare `failed:` (empty kind); unknown reasons fall back to the leading reason token.
- [ ] `bun test`, `bun run typecheck`, and `biome check` are green.

## Early proof point

Task that proves the approach: `.1` — the pure `src/dispatch-failure-pill.ts`
(classifier + resolver) with its own unit suite lands first and is verified in
isolation before the board/status consumers wire to it. If the resolver's
key→epic join proves ambiguous in practice, the fallback is best-effort
boundary-checked longest-match — a wrong pill is cosmetic (render-only, never
affects dispatch).

## References

- CLAUDE.md Autopilot section — authoritative source for the sticky key grammar
  (`close::worktree-finalize:<epic>-<repoHash>`, `worktree-recover:...`) and the reason
  strings (`worktree-merge-conflict`, `worktree-finalize-non-fast-forward`).
- Ground-truth reasons observed live in `dispatch_failures` during triage:
  `worktree-finalize-conflict`, `worktree-recover-conflict`, `worktree-recover-dirty-checkout`,
  `worktree-multi-repo` — the vocab is real, not speculative.
- `plugins/plan/src/verbs/ready.ts:47` — the plan tooling's existing `blocked_by: string[]`
  (dependency ids); the new field is deliberately named `dispatch_failure` to avoid that
  semantic collision and the paradox of "blocked" on a `ready`-verdict row.
- No epic dependencies or overlaps (epic-scout): `fn-1062` touches `cli/commit-work.ts` +
  doc templates only, zero intersection with the board/status/render files.

## Docs gaps

- **cli/status.ts HELP + `StatusData` interface**: name `dispatch_failure` in the `--help`
  prose (`:64`), add a `jq '.data...dispatch_failure'` example (`:78-79`), and add the field
  to the `StatusData`/`TaskView`/`EpicView` interfaces (code, same file).
- **cli/board.ts HELP** (`:105-129`): one line on the `[failed:<kind>]` red pill and the
  short-token vocab (`multi-repo`, `merge-conflict`, `dirty-tree`, `non-ff`).
- **plugins/keeper/skills/autopilot/SKILL.md:219** (optional): mention `data.dispatch_failure`
  as a faster per-row jam-surfacing path alongside `data.needs_human`.
- **CLAUDE.md**: leave unchanged — this is a render detail, not an invariant an agent would
  get wrong; keep `bun scripts/lint-claude-md.ts` green.

## Best practices

- **Ordered prefix rules, not substring-contains bucketing:** match the classifier's
  reason prefixes most-specific-first; `reason.includes(...)` silently collides.
- **One display token per distinct operator action:** collapsing the three conflict variants
  → `merge-conflict` is sound (all need the same "resolve the conflict / retry" action); keep
  `non-ff`, `dirty-tree`, `multi-repo` distinct — they route to different operator responses.
- **Boundary-checked longest-match for the key→id join:** require a `-`/`:`/end boundary after
  the matched id so `fn-106` never matches a key carrying `fn-1061`.
- **Additive, nullable-safe JSON evolution:** `dispatch_failure` is additive (`[]` when clean);
  old consumers ignoring unknown fields are unaffected. `STATUS_SCHEMA_VERSION` is an envelope
  version, distinct from the DB `SCHEMA_VERSION` whitelist — no `keeper/api.py` change (audited:
  api.py never deserializes the status envelope).
