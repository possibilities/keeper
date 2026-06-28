## Description

**Size:** M
**Files:** /Users/mike/code/agentusage/agentusage/scrape_cli.py, /Users/mike/code/agentusage/parse_claude_usage.py, /Users/mike/code/agentusage/parse_codex_status.py, /Users/mike/code/agentusage/tests/test_scrape_cli.py, /Users/mike/code/agentusage/tests/test_parse_claude_usage.py, /Users/mike/code/agentusage/tests/test_parse_codex_status.py, /Users/mike/code/agentusage/README.md

### Approach

Add the same stable error-kind vocabulary to the Python one-shot contract and classify inside `agentusage.scrape_cli`, where both the rendered screen and exception type are available. Scrape exceptions before any rendered screen become `scrape_failed`; `ClaudeUsageEndpointRateLimited` becomes `upstream_limited`; parser exceptions with target panel evidence become `format_changed`; parser exceptions without target panel evidence become `panel_missing`. Bump the scrape contract schema only after task 1 has keeper accepting the new shape.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/agentusage/agentusage/scrape_cli.py:62 — contract schema constant and JSON-arm helpers.
- /Users/mike/code/agentusage/agentusage/scrape_cli.py:114 — `_error` is the single error-arm constructor.
- /Users/mike/code/agentusage/agentusage/scrape_cli.py:135 — `run()` has distinct scrape-exception and parse-exception branches.
- /Users/mike/code/agentusage/parse_claude_usage.py:27 — Claude parse/throttle/no-sub exception classes.
- /Users/mike/code/agentusage/parse_claude_usage.py:244 — bars path header gate; panel evidence for format drift.
- /Users/mike/code/agentusage/parse_claude_usage.py:264 — endpoint-rate-limit sentinel.
- /Users/mike/code/agentusage/parse_codex_status.py:16 — Codex parse exception class.
- /Users/mike/code/agentusage/parse_codex_status.py:20 — Codex panel sentinels available for classifier evidence.
- /Users/mike/code/agentusage/tests/test_scrape_cli.py:88 — existing parse-drift error-arm test.
- /Users/mike/code/agentusage/tests/test_scrape_cli.py:109 — scrape-crash error-arm test.

**Optional** (reference as needed):
- /Users/mike/code/agentusage/README.md:155 — usage contract section for docs update.
- /Users/mike/code/agentusage/CLAUDE.md:1 — repo convention: Python-only, one-shot util, forward-facing docs.

### Risks

The classifier should not pretend to know more than the screen proves. A missing sentinel with no target panel evidence is `panel_missing`, not `format_changed`; the detailed `error_type`, `message`, and excerpt remain the diagnostic truth for humans.

### Test notes

Use monkeypatched `scrape()` and parser functions; do not spawn real Claude/Codex. Add table-style tests for scrape crash, Claude endpoint throttle, Claude parser drift with panel evidence, Claude missing panel, Codex parser drift with `5h limit:` evidence, and Codex missing panel.

## Acceptance

- [ ] Error-arm JSON includes `error_kind` for scrape crashes and parse failures.
- [ ] Claude and Codex parser failures classify as `format_changed` only when target panel evidence is present.
- [ ] Endpoint throttling classifies as `upstream_limited`; pre-render scrape exceptions classify as `scrape_failed`.
- [ ] Contract schema/docs are updated consistently with keeper compatibility from task 1.
- [ ] `cd /Users/mike/code/agentusage && uv run pytest` passes.

## Done summary

## Evidence
