## Overview

Promote the three currently-conflated "in-motion" reasons (`job-running`,
`sub-agent-running`, `planner-running`) out of the `blocked` Verdict tag
into a sibling `running` tag with a `RunningReason` payload. Today the
projection lies about rows that are actively working — `blocked` ought
to mean "stuck", not "in motion". After this split, `running` carries
the three motion reasons and `blocked` is reserved for genuinely-
waiting rows.

## Quick commands

- `bun test test/readiness.test.ts test/board.test.ts test/autopilot.test.ts`

## Acceptance

- [ ] `Verdict` union widened with a fourth `running` tag carrying a
  `RunningReason` payload; the three `*-running` cases removed from
  `BlockReason`; renderer + autopilot consumers + tests updated; all
  three test suites green.
