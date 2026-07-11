## Overview

Prepare the second focused upstream PR from the pi-subagents fork
(/Users/mike/src/possibilities--pi-subagents): subagent runs that end on a
provider error, abort, or empty `length` stop are currently reported as
`completed` with an empty result ("No output"), and post-compaction output
streaming silently ceases. The first fork PR (nested-spawn ctx fallback,
branch fix/nested-subagent-spawn-ctx) is already in flight and is NOT part
of this epic.

## Quick commands

cd /Users/mike/src/possibilities--pi-subagents && ./node_modules/.bin/vitest run

## Acceptance

- [ ] A branch off master in the fork implements terminal-status propagation,
      collector-reset narrowing, and the output-file compaction fix, with
      A/B-verified tests, all four upstream checks green, and a drafted PR
      body — pushed to origin, PR not opened (human decision).
