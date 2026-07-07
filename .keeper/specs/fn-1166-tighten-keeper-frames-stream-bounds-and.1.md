## Description

Two `keeper frames` contract-honesty fixes from the fn-1161 audit, bundled
because both touch the frames agent-facing help/contract surface.

F1 (evidence: cli/frames.ts, the default-duration floor
`if (!follow && durationMs === null && maxFrames === null)`): once
`--max-frames` is set, `durationMs` stays `null` and no wall-clock teardown
timer is armed, so `keeper frames --view board --max-frames 20` on an idle
board that never reaches 20 data frames hangs silently until SIGINT/parent
death. Fix: give `--max-frames` alone a wall-clock floor — apply the default
duration whenever `--follow` is absent so a bounded chunk always terminates
— and/or correct the `--max-frames` help so it no longer reads as an
unconditional bound.

F2 (evidence: src/frames-emitter.ts `emitKeepalive` at the interface decl,
definition, and returned object — grep finds zero production callers — and
cli/frames.ts AGENT_HELP line `type : baseline | frame | keepalive | trailer`):
the agent runbook advertises a `keepalive` record type no viewer ever emits.
Fix: make the documented contract match production — either wire a bounded
idle keepalive into the frames run, or trim the unused `emitKeepalive`
method + `keepalive` record type and drop it from the three AGENT_HELP lines
that mention it, so what's advertised equals what's produced.

Files: cli/frames.ts (teardown gate + AGENT_HELP), src/frames-emitter.ts
(keepalive method/type).

## Acceptance

- [ ] `keeper frames --max-frames N` without `--for`/`--follow` terminates on a wall-clock floor (trailer + exit), verified on an idle stream that never reaches N; help text no longer implies an unconditional bound.
- [ ] The `keeper frames` contract is honest: no AGENT_HELP-advertised record type is unproduced — `keepalive` is either emitted by a production path or removed from the type, method, and AGENT_HELP together.
- [ ] A pure-tier test documents the chosen `--max-frames`-alone teardown behavior.

## Done summary

## Evidence
