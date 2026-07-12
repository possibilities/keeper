## Overview

The Agent Bus writes a join/part/reap/takeover forensic row into the
bus.db messages table on every channel lifecycle event, and those
control-namespace rows only age out at the general 7-day horizon — so
takeover churn accumulates faster than retention sheds it (~141k rows /
~37MB observed, with bus sends tripping the 5s client cap). Give the
control-namespace rows their own bounded retention so the forensic log
stays useful without starving the serve loop.

## Quick commands

```bash
sqlite3 "$(keeper query profiles --json >/dev/null 2>&1; echo ~/.local/state/keeper/bus.db)" \
  "SELECT count(*) FROM messages WHERE namespace='bus'"
```

## Acceptance

- [ ] Control-namespace forensic rows are pruned under a dedicated bounded horizon/cap by the bus worker's paced retention pass; genuine chat/pair rows and queued-for-wake rows are never touched by the new prune
- [ ] The pre-existing backlog drains to the bound across successive retention ticks with per-tick work staying bounded, and bus send latency stays under the client response cap
