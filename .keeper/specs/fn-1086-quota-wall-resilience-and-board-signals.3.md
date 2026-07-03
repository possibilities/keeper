## Description

**Size:** S
**Files:** test/ (fold test additions), src/daemon.ts (only if a gap is found)

### Approach

Close inventory item 10's residue: verify the landed reap reasons (KillReason/CloseKind →
jobs.kill_reason) actually populate on the mass-reclassification path — the observed
pattern where many jobs flip stopped at one instant in a reaper batch. Mine one historical
batch (the 14:43:37 flip) read-only, then write a fold test seeding a batch-reap event
sequence and asserting every job row carries its reason. Fix small mint gaps if found
(daemon.ts mint sites only); anything larger gets filed with evidence, not patched here.
Stay out of exec-backend.ts.

### Investigation targets

**Required** (read before coding):
- The Killed/DispatchExpired mint sites + the batch-reap sweep in src/daemon.ts
- jobs fold kill_reason handling in src/reducer.ts

### Test notes

One fold test per batch shape; refold-equivalence green.

## Acceptance

- [ ] Batch-reap fold test asserts reasons populate; gaps fixed or filed with evidence

## Done summary

## Evidence
