## Description

**Size:** S
**Files:** parse_codex_status.py, tests/test_parse_codex_status.py, README.md

### Approach

Replace the split `FIVE_HOUR_RE` / `WEEKLY_RE` reset suffix assumptions with a shared parser for a limit row's percent-left and reset suffix. The shared suffix should accept `resets HH:MM` and `resets HH:MM on DD Mon`; date-less values call `_resolve_today_time`, and date-bearing values call `_resolve_date_time`. Keep row-label matching strict (`5h limit:` vs `Weekly limit:`) so a missing or malformed row still fails loudly with the current label-specific `CodexStatusParseError` messages.

### Investigation targets

**Required** (read before coding):
- parse_codex_status.py:23 — 5h row regex currently accepts only `resets HH:MM`.
- parse_codex_status.py:27 — weekly row regex currently requires `resets HH:MM on DD Mon`.
- parse_codex_status.py:42 — `_resolve_today_time` already implements date-less reset resolution.
- parse_codex_status.py:49 — `_resolve_date_time` already implements dated reset resolution and month validation.
- tests/test_parse_codex_status.py:45 — current fixtures and percent-left inversion checks.
- tests/test_parse_codex_status.py:137 — the date-less weekly case currently expects a strict error and should become a happy-path guard.
- /Users/mike/.local/state/agentusage/codex.error.json — live excerpt to mirror in a regression fixture without copying temp paths.

**Optional** (reference as needed):
- README.md:176 — documented `usage` shape and Codex example reset values.
- agentusage/scrape_cli.py:168 — classified parser failures should remain `format_changed` only when parser still raises.

### Risks

Over-broad regexes could accidentally match the Spark rows while parsing the primary block, or accept a malformed line that should signal drift. Keep the primary-vs-Spark text split unchanged and make each row parser search only within the provided block.

### Test notes

Add table-driven parser fixtures covering all four combinations that matter: 5h date-less, 5h dated, weekly date-less, weekly dated, across primary and Spark blocks. Preserve strict error tests for missing rows, malformed reset text, and unknown month names.

## Acceptance

- [ ] `parse()` accepts a primary block where both `5h limit` and `Weekly limit` include `on DD Mon`.
- [ ] `parse()` accepts a primary block where `Weekly limit` omits the date suffix.
- [ ] `parse()` accepts Spark 5h/week rows with either reset suffix shape.
- [ ] Existing percent-left inversion and timezone-offset assertions still pass.
- [ ] `uv run pytest tests/test_parse_codex_status.py tests/test_scrape_cli.py` passes.
- [ ] After deploy, the live Codex row in `keeper usage` leaves `format`/`stale` on the next successful scrape.

## Done summary
Shared the Codex reset-suffix parser so 5h and Weekly rows each accept resets HH:MM (today/tomorrow) or resets HH:MM on DD Mon (this/next year); added table-driven combo fixtures and a live-drift regression panel.
## Evidence
