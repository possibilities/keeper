## Overview

The `/plan:panel` and `/keeper:pair` skill docs show Monitor tool-call examples that pass an
`until=` argument the Monitor tool does not accept — its schema is `additionalProperties: false`
over exactly `command` / `description` / `persistent` / `timeout_ms`. Every panel and pair run
therefore fails its Monitor calls with "Invalid tool parameters" on the first attempt, burns a
recovery turn dropping the param, then proceeds. Removing the bogus param from the three example
blocks (and rounding out the under-specified pair example to a complete, schema-valid call) makes
the documented calls land on the first try.

## Quick commands

- `grep -rn "until=" plugins/` — after the fix returns no hits (currently 3: panel x2, pair x1).

## Acceptance

- [ ] No `until=` remains in the panel or pair skill docs.
- [ ] The pair Monitor example is complete and schema-valid (all four params).
- [ ] Surrounding prose and the valid panel param lines are untouched; no tombstone narration.
