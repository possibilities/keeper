## Overview

`planctl --help` is 52 lines / 2.8k chars and is the most agent-called help in the event log (~30 invocations, almost always defensively truncated with `| head -N`). Tighten the top-level surface to ~25 lines so one un-truncated call answers "what verbs exist". Per-verb helps are already lean (6-26 lines) — out of scope.

## Quick commands

- `planctl --help | wc -l` — target <= ~28

## Acceptance

- [ ] `planctl --help` <= ~28 lines: one line per verb (group verbs collapsed), no multi-line prose blocks
- [ ] No verb hidden: every invocable verb/group appears exactly once
