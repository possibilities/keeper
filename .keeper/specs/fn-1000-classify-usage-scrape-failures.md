## Overview

Add a stable usage-scrape failure classification that separates scraper/runner failures from target TUI format drift, then project it through keeper usage so stale quota rows show what kind of failure is blocking freshness. The end state covers both Claude `/usage` and Codex `/status`: the Python one-shot util emits a machine-readable `error_kind`, keeper preserves it across the envelope, projection, and subscription stream, and `keeper usage` renders a concise label while retaining the detailed exception type/message.

## Quick commands

- `cd /Users/mike/code/agentusage && uv run pytest`
- `cd /Users/mike/code/keeper && bun test test/usage-scrape-runner.test.ts test/usage-scraper-worker.test.ts test/usage-worker.test.ts test/usage.test.ts test/schema-version.test.ts`
- `cd /Users/mike/code/keeper && keeper usage --snapshot`

## Acceptance

- [ ] Agentusage error JSON includes a stable `error_kind` for Claude and Codex parse failures, endpoint throttles, and scrape crashes, while still carrying `error_type`, `message`, and `screen_excerpt`.
- [ ] Keeper accepts the new scrape contract without rejecting the current v1 shape during rollout; v2 `error_kind` values and v1 fallback classifications both fold safely.
- [ ] `usage.error_kind` is projected, subscribed, and rendered in `keeper usage` with short labels such as `format`, `panel`, `scrape`, `upstream`, and `runner`.
- [ ] The current Codex weekly reset shape classifies as format drift without changing the parser acceptance rules; fixing the parser remains follow-up work.
- [ ] Schema version and keeper-py supported-version whitelist move together.

## Early proof point

Task `.1` proves the keeper side can accept, persist, and classify the new field while staying compatible with the current agentusage contract. If the dual-version contract support gets awkward, keep schema v1 tolerant and add the new field as optional on the error arm rather than forcing a lockstep deploy.

## References

- `/Users/mike/code/agentusage/agentusage/scrape_cli.py:62` — scrape contract schema and error-arm assembly.
- `/Users/mike/code/agentusage/parse_claude_usage.py:27` — Claude parser exception family and current no-sub/throttle sentinels.
- `/Users/mike/code/agentusage/parse_codex_status.py:16` — Codex parser exception family and panel sentinels.
- `src/usage-scrape-runner.ts:91` — keeper scrape-result contract parser.
- `src/usage-scraper-worker.ts:1137` — failure normalization into stale envelopes.
- `src/usage-worker.ts:100` — usage snapshot message shape and gate.
- `src/db.ts:996` / `src/reducer.ts:2830` / `src/collections.ts:352` — usage projection schema, fold, and subscription descriptor.
- `cli/usage.ts:400` — stale-error render path.

## Docs gaps

- **README.md**: update the usage architecture / install section to describe classified scrape failures and the new `error_kind` projection surface.
- **/Users/mike/code/agentusage/README.md**: update the scrape contract section so the error arm documents `error_kind` and the classifier meanings.
