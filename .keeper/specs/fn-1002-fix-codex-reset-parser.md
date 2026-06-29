## Overview

Update agentusage's Codex `/status` parser so it accepts the reset-time shapes Codex currently renders for both primary and GPT-5.3-Codex-Spark buckets. Codex can render a reset as either `resets HH:MM` or `resets HH:MM on DD Mon` on both `5h limit` and `Weekly limit` rows, so the parser should parse the shared suffix and resolve date-less values with the existing today/tomorrow rule while date-bearing values use the existing date resolver.

## Quick commands

- `cd /Users/mike/code/agentusage && uv run pytest tests/test_parse_codex_status.py tests/test_scrape_cli.py`
- `cd /Users/mike/code/agentusage && uv run pytest`
- `cd /Users/mike/code/keeper && keeper usage --snapshot`

## Acceptance

- [ ] Codex primary `5h limit` parses when the reset suffix includes `on DD Mon`.
- [ ] Codex primary `Weekly limit` parses with and without `on DD Mon`.
- [ ] Codex-Spark `5h limit` and `Weekly limit` use the same accepted reset suffix shapes.
- [ ] Date-less resets keep the today/tomorrow behavior; date-bearing resets keep the this-year/next-year behavior.
- [ ] Missing or malformed reset suffixes still raise `CodexStatusParseError` with useful labels.
- [ ] Live `keeper usage` can return Codex to `active` after the next successful scrape.

## Early proof point

Task `.1` is the whole parser/test slice. If the shared reset parser becomes too broad, constrain it by matching the row label first and parsing only the parenthesized `resets ...` suffix rather than broadening the full-line regex.

## References

- `/Users/mike/code/agentusage/parse_codex_status.py:23` — current 5h regex only accepts date-less reset times.
- `/Users/mike/code/agentusage/parse_codex_status.py:27` — current weekly regex requires a date suffix.
- `/Users/mike/code/agentusage/tests/test_parse_codex_status.py:45` — canonical captured panel fixtures.
- `/Users/mike/.local/state/agentusage/codex.error.json` — current live failure excerpt shows both `5h` and `Weekly` rows with `on DD Mon`.
- `fn-1000-classify-usage-scrape-failures` — classified `format_changed` surfacing is landed; this plan fixes the underlying parser.

## Docs gaps

- **/Users/mike/code/agentusage/README.md**: adjust Codex usage/reset wording only if it currently implies fixed 5h-vs-weekly reset suffix shapes.
