## Overview

`planctl epic add-deps <epic> fn-12` skips with SKIPPED_NOT_FOUND while the
full slug wires — the resolver matches exact epic filenames only. Accept
number-only `fn-N` as an input convenience across the dep-resolution path:
resolve by exact epic integer, route cross-project collisions to the
existing ambiguous channel, and normalize the persisted edge to the full
slug id so on-disk `depends_on_epics` stays canonical.

## Quick commands

- `uv run pytest tests/test_cross_project_epic_deps.py tests/test_epic_add_deps.py` — resolver + verb suites green

## Acceptance

- [ ] `epic add-deps <epic> fn-N` wires when exactly one epic with that number exists in scope; persisted edge carries the full slug id
- [ ] Same-number epics in two projects route to the ambiguous channel, never a silent pick
- [ ] `fn-1` never matches `fn-10` (integer equality via parse_id, not string prefix)
