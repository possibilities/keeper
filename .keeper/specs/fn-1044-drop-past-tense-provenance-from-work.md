## Overview

The work-shadow dispatch guard shipped with two source comments that retell
the originating incident in past tense, which violates repo rule #0
(forward-facing comments only, no past-tense provenance). This follow-up
rewrites both comments to state the current hazard and behavior without the
incident retelling, keeping the code aligned with the repo's docs discipline.

## Acceptance

- [ ] Neither `findShadowingWorkManifest`'s doc-comment nor the inline probe
      comment in `runReconcileCycle` contains past-tense incident provenance.
- [ ] Both comments retain a forward-facing statement of the shadow hazard and
      the guard's behavior.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | Verified past-tense provenance at autopilot-worker.ts:402-405 and :3631 violates rule #0. |
| F2 | culled | —  | Remedy is a scope-note comment; plugin_dirs are fail-loud hard deps, gap not reachable in practice. |
| F3 | culled | —  | Lexical containment at :443 is fail-safe and consistent with discoverPlugins; realpathSync would diverge. |
| F4 | culled | —  | ConfigError swallow verified correct; re-raise path is unreachable, test locks an unreachable contract. |
| F5 | culled | —  | Close-verb bypass follows from the visible pluginDir!=null guard; marginal coverage of an obvious guard. |

## Out of scope

- Widening the probe to scan `plugin_dirs` (F2) — deferred; plugin_dirs are controlled fail-loud hard deps.
- Switching containment to `realpathSync` (F3) — deferred; current lexical check matches launcher path-handling.
- Adding tests for the fail-open ConfigError swallow (F4) and close-verb bypass (F5) — deferred as low-value coverage.
