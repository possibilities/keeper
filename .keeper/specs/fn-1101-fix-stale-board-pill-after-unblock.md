## Overview

After `keeper plan unblock <task>`, a long-running board TUI kept rendering the stale
[::rt:blocked] pill while a freshly-started TUI rendered the correct state — projection
right, live watch stream stale. The observing TUI had survived hundreds of daemon restarts
that day via reconnect. Two suspects: a reconnect that resumes on a snapshot and misses
gap deltas, or the unblock verb's runtime-overlay flip not emitting on the coarse delta
stream (unblock deliberately skips the validation restamp, so its delta path is the
least-exercised).

## Quick commands

- arm `keeper watch`, bounce the daemon, `keeper plan unblock <task>` around the bounce, compare against a fresh watch

## Acceptance

- [ ] An unblock is reflected on an already-connected watch stream without restarting the consumer, including across a daemon bounce
