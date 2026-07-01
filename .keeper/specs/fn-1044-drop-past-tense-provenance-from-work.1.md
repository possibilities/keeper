## Description

From finding F1 (evidence: `src/autopilot-worker.ts:402-405` and
`src/autopilot-worker.ts:3631`). Two comments carry past-tense incident
provenance that violates repo rule #0 (forward-facing comments only):
the `findShadowingWorkManifest` doc-comment says "exactly the collision the
source epic hit when an arthack `work` plugin in a scan dir shadowed the
cell until a rename handoff", and the inline probe comment in
`runReconcileCycle` says "the exact hazard that gated the source epic's
cutover". Both sites are the same theme in the same file (file-touch
overlap), so they land as one commit. Rewrite each to state the current
shadow hazard and the guard's behavior without the incident retelling.

## Acceptance

- [ ] The `findShadowingWorkManifest` doc-comment (~:397-410) states the
      forward-facing rationale (a non-cell `work` manifest in a scan dir
      shadows the selected cell) with no past-tense provenance.
- [ ] The inline probe comment in `runReconcileCycle` (~:3629-3635) states
      the current hazard with no past-tense provenance.
- [ ] `bun test` stays green.

## Done summary

## Evidence
