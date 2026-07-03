## Description

**Size:** S
**Files:** src/reducer.ts or src/daemon.ts watch-delta emit path, test/ (transition test)

### Approach

Diagnose then fix the completion-window flap: verdicts oscillated completed→running→completed
and close rows cycled running↔blocked repeatedly around completion moments (six observed
instances in one evening). Trace one real sequence (fn-1083.1's event window) to the fold or
snapshot-emit ordering race that produces it, then fix at the source if it is an ordering bug,
or debounce at the watch-delta emit (suppress A→B→A within one drain batch) if the transient
state is inherent. The watch stream is the supervisor/operator surface — flaps cost real
diagnostic attention.

### Investigation targets

**Required** (read before coding):
- The verdict derivation feeding watch deltas (reducer verdict fields + the coarse-delta emit in the daemon watch path)
- Tonight's flap windows in events (fn-1083.1 ~19:2x, fn-1084 close ~18:1x) — the concrete sequences

### Risks

- A debounce must never swallow a REAL regression (done genuinely rescinded by reconcile) — suppress only same-batch A→B→A, pass through settled changes.

### Test notes

Seed the observed event sequence in a fold test; assert the emitted delta stream is flap-free while a genuine rescind still emits.

## Acceptance

- [ ] The observed flap sequences produce clean delta streams; genuine rescinds still visible
- [ ] Root cause documented in the Done summary (ordering bug vs inherent transient)

## Done summary

## Evidence
