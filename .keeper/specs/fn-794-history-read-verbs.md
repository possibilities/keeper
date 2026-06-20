## Overview

Give agents a stable CLI seam over keeper.db's session history: three
read-only verbs (prompt search, file attribution lookup, session event
spine) so external consumers stop hand-writing sqlite against a schema
keeper owns. No schema change, no FTS — plain LIKE scans.

## Quick commands

```bash
bun cli/keeper.ts search-history "<term>"
bun cli/keeper.ts find-file-history "<path-fragment>"
bun cli/keeper.ts show-session-events --session-id <id>
```

## Acceptance

- [ ] Three read-only history verbs registered, documented in USAGE, JSON on stdout, tested under sandboxEnv
