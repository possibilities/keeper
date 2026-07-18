## Overview

Live-Partner capture keys its transcript boundary on the injected artifact
path surfaced by the Bus notification renderer. When that notification line
exceeds NOTIFY_LINE_BUDGET it falls back to a path-less failure line, so a
deep artifact root or long sender label silently defeats capture even though
the message was delivered. This follow-up makes the capture boundary robust
to notification budgeting so the epic's honest-capture guarantee holds under
non-default bus paths.

## Acceptance

- [ ] The capture boundary is observable to the receiver regardless of
      notification-line length (path never silently dropped from the marker).
- [ ] A deep artifact root / long sender no longer forces a boundary-less
      timed_out capture on an otherwise-delivered message.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | cli/bus.ts renderMessageNotification drops the artifact path via artifactFailureNotification when the notify line exceeds NOTIFY_LINE_BUDGET(400); capture keys on that path so a deep root/long sender silently defeats capture until timeout. |
| F2 | culled | —  | Duplicated resolveBusSockPath (main.ts vs db.ts) is byte-identical with no behavior difference - cleanliness only, below the keep bar. |
| F3 | culled | —  | resolveBusArtifactRoot inlines a trim-variant KEEPER_BUS_DB derivation; harmless today, divergence only on a whitespace-only env value - theoretical, below the keep bar. |

## Out of scope

- The two culled duplicated-helper cleanups (F2, F3) - no behavior impact.
- Any change to the nine-key wire envelope or timeout semantics.
