## Description

**Size:** S
**Files:** cli/await.ts, cli/keeper.ts, cli/descriptor.ts, test/await.test.ts

### Approach

Add a probe mode: evaluate the armed condition(s) once against the
first painted snapshot, emit an explanation envelope (state, detail,
holders — per slot for an AND aggregate), and exit — 0 when the
condition holds, a NEW additive registry exit code for "evaluated
cleanly, condition does not hold" (frozen 3/4/5 untouched; not 124 —
GNU timeout collision). Probe implies a bounded connect deadline (a
probe that hangs on a down daemon defeats its purpose; unreachable
keeps the existing unreachable code, distinct from does-not-hold).
Define edge-triggered conditions (changed/epic-added/epic-removed) as a
usage error under probe — they have no instantaneous truth value — and
server-up probes as an ordinary reachability check. Register the code
in the central exit-code table and its descriptor mirror, and extend
HELP/agent-help.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at
authoring time, but the repo moves.*

**Required** (read before coding):
- cli/await.ts:1892+ — the first-paint eval pass the probe rides
- cli/await.ts:1846-1864 — edge-triggered slot baselines (why probe
  must reject them)
- cli/keeper.ts:179-191 — EXIT_CODES registry; cli/descriptor.ts:729-733
  exit-code mirror (keep in lockstep)
- cli/await.ts:1047-1055 — server-up dedicated subscribe

### Risks

- Exit-code registry and descriptor mirror drifting — assert both in
  the same test
- Probe + --fail-on-stuck: a jam sticky should surface in the probe
  envelope, not silently read as does-not-hold

### Test notes

Fast-tier via the injected connect factory: holds→0; does-not-hold→new
code with holder envelope; daemon-down→unreachable code within the
deadline; edge-triggered→usage error; AND aggregate reports per-slot
states.

## Acceptance

- [ ] A probe exits 0 when the condition holds now and with the new
  documented registry code when it evaluates cleanly and does not
  hold, emitting an envelope naming the holders per slot
- [ ] A probe against an unreachable daemon terminates within a
  bounded deadline with the existing unreachable semantics
- [ ] Edge-triggered conditions are a usage error under probe;
  the exit-code registry and its descriptor mirror agree
- [ ] Fast suite green

## Done summary

## Evidence
