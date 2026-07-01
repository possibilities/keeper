## Overview

The launch-time resolution of the constant `work:worker` has no runtime
defense against an external `work`-named plugin sitting in a claude
`plugin_scan_dir` and silently shadowing the `--plugin-dir`-selected cell.
This exact collision materially gated the source epic's cutover (the arthack
`work` plugin had to be renamed via handoff before task .3 could land). Add a
fail-loud preflight so a re-introduced stray `work` plugin errors legibly at
dispatch instead of silently spawning the wrong worker.

## Acceptance

- [ ] A dispatch-time preflight probes the actual scan dirs (not just the repo)
      for a non-cell `work`-named manifest and mints a legible sticky failure
      when one would shadow `work:worker`.
- [ ] Test coverage exercises a `work` manifest sitting in a real scan-dir
      position, not only an in-repo/synthetic-tmpdir stray.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | consistency-generated-guard.test.ts:190-226 collidingWorkManifests walks REPO only; launch-time work:worker has no runtime scan-dir probe, and this collision materially gated the cutover |
| F2 | culled | — | autopilot-worker.ts:3492 dirExists on a file path is functionally correct (existsSync handles files); pure naming nitpick |
| F3 | culled | — | auditor-rated low-value test gap; the KEEPER_ROOT contract is already covered observably by the absolute cell --plugin-dir assertions |
| F4 | merged-into-F1 | .1 | F4 is the test-coverage face of F1's repo-only blast radius; both fold into the one scan-dir preflight-guard task |

## Out of scope

- Renaming `dirExists` to `pathExists` (culled F2 — functionally correct naming nitpick).
- A direct unit test for the `KEEPER_ROOT` module-derived fallback (culled F3 — contract covered observably).
