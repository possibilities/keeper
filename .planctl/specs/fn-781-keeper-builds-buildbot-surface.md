## Overview

New read-only `keeper builds` surface: a glanceable dashboard showing every
registered buildbot builder (project) and its latest build status
(success / failure / running, build number, state string, age). Data flows
through keeper's full event-sourced pipeline — a new `builds-worker`
(keeper's FIRST HTTP-polling producer, ~15s cadence against the local
buildbot master's REST API) posts change-gated snapshot messages to main,
main appends synthetic `BuildSnapshot` / `BuildDeleted` events, the reducer
folds them into a new `builds` projection (one row per builder), and a new
`cli/builds.ts` TUI subscribes via the existing collection machinery.
Buildbot already pages Telegram on failures; this is a dashboard, not an
alerting path.

Settled decisions: poll (not websocket); buildbot-unreachable = silent
staleness (emit nothing on fetch failure, TUI renders age); entity key =
builder NAME (stable across master DB rebuilds; numeric builderid stored
as informational column); gate hash preserved on fetch failure; transient
fetch errors caught inside the poll loop (never reach onerror/fatalExit);
running builds (`complete:false, results:null`) render distinctly and
`state_string` is EXCLUDED from gate identity so a build emits exactly two
events (start, finish); disappeared/ghost builders are tombstoned
(`BuildDeleted` -> fold deletes the row).

## Quick commands

- `keeper builds --snapshot` — one-shot render of every project row
- `curl -s "$(yq '.buildbot_url' ~/.config/keeper/config.yaml)/api/v2/builders" | head` — raw source sanity check
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT project, build_number, results, state_string FROM builds ORDER BY project"` — projection sanity check
- `bun run test:full` — mandatory gate (daemon/worker/db/reducer paths)

## Acceptance

- [ ] `keeper builds` renders one row per registered (non-ghost) builder: project name, success/failure/running glyph, build number, state string, age
- [ ] Unchanged buildbot state emits zero events between polls; a build emits exactly two events (start, finish)
- [ ] A builder removed from the buildbot config (or gone ghost) is tombstoned out of the projection
- [ ] Buildbot down or unreachable: daemon unaffected, no events, rows age silently; recovery emits no spurious events
- [ ] SCHEMA_VERSION 64 paired with keeper/api.py SUPPORTED_SCHEMA_VERSIONS in the same commit; `bun run test:full` green

## Early proof point

Task that proves the approach: ordinal 1 (schema + event contract + fold +
descriptor). If the payload/fold contract turns out wrong, revise it before
the worker (ordinal 2) and TUI (ordinal 3) consume it — nothing downstream
has landed yet.

## References

- Buildbot result codes (0 SUCCESS, 1 WARNINGS, 2 FAILURE, 3 SKIPPED, 4 EXCEPTION, 5 RETRY, 6 CANCELLED): https://docs.buildbot.net/latest/developer/results.html
- Buildbot REST API v2: https://docs.buildbot.net/latest/developer/rest.html
- Bun AbortSignal.timeout macOS bug (use manual AbortController + clearTimeout): https://github.com/oven-sh/bun/issues/7512
- `fn-776` (overlap) — comment-scrub tasks touch src/db.ts (in progress), src/daemon.ts, src/reducer.ts, cli/keeper.ts — same files this epic edits
- `fn-780` (overlap) — dash task .2 rewrites the cli/keeper.ts USAGE/registration block this epic also edits

## Docs gaps

- **README.md**: "Seven collections" count + enumeration (line ~113); "All five viewers" + subcommand enumerations (~203, ~573, ~579); config.yaml reference block (~290-337) gains `buildbot_url`; Architecture workers enumeration gains the first outbound-HTTP worker + a one-sentence change-detection carve-out; "63-version migrate() ladder" (~551) becomes 64
- **CLAUDE.md**: "63-version migrate() ladder" mention (~214) becomes 64 — edit CLAUDE.md in place (AGENTS.md is a symlink)
- **~/.config/keeper/config.yaml**: add commented `buildbot_url` key in the live config (stow-managed comment style matches existing keys)

## Best practices

- **setTimeout-after-completion, never setInterval:** a hung fetch must skip poll slots, not queue overlapping requests [practice-scout, verified]
- **Manual AbortController deadline + clearTimeout in finally:** `AbortSignal.timeout()` mis-fires on Bun/macOS (oven-sh/bun#7512); combine with the shutdown signal via `AbortSignal.any` so shutdown aborts in-flight fetches
- **Never-built builders return `{"builds": []}`:** emit nothing — no null row
- **Ghost builders (empty `masterids`) are dead config leftovers:** filter them at enumeration
- **`order=-number`, not `-buildid`:** build number is the per-builder counter; buildid is a global autoincrement (buildbot#3427)
- **Fixed cadence, no backoff, no circuit breaker:** local poller with silent-staleness semantics — keep polling indefinitely
