## Overview

Project Claude rate-limit state into keeper's `usage` projection server-side
and colocate it with the per-profile usage stacks in `scripts/usage.ts`,
replacing the standalone "Rate limits by profile" block. Separately, swap
agentuse's hardcoded `ACCOUNTS` registry for an XDG config that is a pure
list of profile names, deriving each multiplier from the profile's
`organizationRateLimitTier`. End state: each tracked profile's usage stack
shows a colocated `rate-limited <rel>` line; untracked profiles (a rate-limit
with no agentuse usage row) are dropped from the view entirely; the agentuse
account list is human-editable in one config file.

Precondition already shipped (agentuse fd283d1): account ids were renamed so
keeper's `usage.id` == the on-disk profile dir basename, which is what makes
the `usage.id = profiles.profile_name` join possible.

## Quick commands

- `cd ~/code/keeper && bun test test/reducer.test.ts test/usage.test.ts test/collections.test.ts`
- `cd ~/code/keeper && bun run scripts/usage.ts` (observe a colocated `rate-limited <rel>` line under a tracked profile stack; no separate "Rate limits by profile" block; codex stack shows none)
- `cd ~/code/agentuse && uv run python -c "import daemon; print(daemon.ACCOUNTS)"` (multipliers match: default=5, multi-claude-1=1, multi-claude-2=1, multi-claude-3=20)

## Acceptance

- [ ] keeper `usage` rows carry `last_rate_limit_at` + `last_rate_limit_session_id`, maintained by a bidirectional reducer fan-out inside the existing `BEGIN IMMEDIATE`, joined to `profiles` via a derived `profile_name = basename(config_dir)` column
- [ ] a from-scratch re-fold reproduces byte-identical `usage` + `profiles` rows (determinism preserved); no clock/env/OS reads added to any fold
- [ ] `scripts/usage.ts` is single-collection (`usage` only); each tracked stack shows a colocated rate-limit line when set; codex and no-limit stacks omit it; untracked profiles do not render
- [ ] agentuse reads an XDG `config.yaml` name-list and derives each multiplier from the profile's `organizationRateLimitTier`; codex is appended in code; missing/malformed config and missing/unknown tier degrade gracefully

## Early proof point

Task that proves the approach: `<epic>.1` (keeper server-side projection join). If the bidirectional fan-out can't preserve re-fold determinism cleanly, fall back to a read-side join in the collection layer before touching the UI. Tasks `.2` and `.3` are low-risk once `.1` lands.

## References

- keeper `CLAUDE.md` event-sourcing invariants — the `syncJobIntoEpic` / `syncPlanctlLinks` / `syncJobLinksOnJobWrite` fan-out idiom this mirrors
- fn-639 added the `profiles` projection (schema v33); this builds directly on it (schema v35)
- agentuse `daemon.py:46-49` documents the tier→multiplier mapping; verified live: default_claude_ai→1x, default_claude_max_5x→5x, default_claude_max_20x→20x

## Docs gaps

- **keeper/CLAUDE.md**: extend the "Cursor + projection advance in the SAME BEGIN IMMEDIATE" bullet with the schema-v35 usage<->profiles bidirectional fan-out + `profile_name`; revise the v33 `profiles` parenthetical (rate-limit no longer NULL-only on seed-only profiles)
- **keeper/README.md**: `## Architecture` schema para (append "As of schema v35…"); the `scripts/usage.ts` description (~L518-534) → single-collection colocated design (drop dual-collection / separate-block / BOTH-row-sets sidecar text)
- **keeper/src/db.ts, src/reducer.ts, src/usage-worker.ts, scripts/usage.ts**: docstrings — new columns, the ON CONFLICT "preserve" invariant, UsageSnapshotPayload omits rate-limit fields, usage-worker no longer scoped to `profiles`

## Best practices

- **Reuse `projectBasename` (src/epic-deps.ts), don't reimplement:** it already strips trailing slashes POSIX-style with no `node:path`. Guard `profile_name != ''` on both sides of the join so the `''` sentinel never cross-contaminates.
- **Keep multiplier derivation out of keeper's fold:** agentuse computes it and writes it into the state file; keeper folds the event payload. Recomputing inside the fold from a live JSON read would break re-fold determinism.
- **Python: `yaml.safe_load` (never `yaml.load`), `.get()` chains with defaults, cap file size before `json.load`, honor `XDG_CONFIG_HOME` before `~/.config`** — missing/malformed config or tier must degrade to a safe default, never crash the daemon.
