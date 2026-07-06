## Description

**Size:** M
**Files:** src/daemon.ts, src/agent/codex-session-index.ts, src/codex-state-worker.ts, test/codex-resume.test.ts, test/codex-adoption.test.ts

### Approach

A knob-gated discovery sweep (sibling of the codex resume sweep tick, own no-throw guard) enumerates rollouts whose originator is STRICTLY absent/empty — a present-but-unmatched originator is skipped, never adopted — bounded by a recency window over rollout day-dirs plus a small per-tick mint cap so a knob-flip over months of history drains gradually and scan cost never grows with harness lifetime; the knob re-reads each tick (live kill-switch). Candidate selection reuses the existing sole-unambiguous-cwd refuse semantics unchanged: on any collision, adopt nothing. The mint is a sibling of the birth mint — coordless, adopted-marked, job id and resume target both the rollout uuid (uuid-validated), event ts from the rollout SessionMeta's immutable session-start timestamp converted to the event-ts unit (never file mtime, never wall-clock; unparseable meta → skip) — executed by MAIN inside BEGIN IMMEDIATE with a re-read-before-mint guard (skip if any job already claims the uuid), head-line-bounded file reads so the write lock never spans large IO, and cwd canonicalized on the raw value before it enters the row. The worker only hints; main mints — sole-writer intact. A half-written final line or unparseable record skips that rollout this tick without failing the scan.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:7700-7720 — codexResumeSweepTimer: the sibling tick site + the re-read-before-mint idempotency template
- src/daemon.ts:2964, :3269, :3303-3320 — insertBirthSessionStart (the mirror), scanBirthDir BEGIN IMMEDIATE + poison-park discipline
- src/agent/codex-session-index.ts:141-222 — resolveCodexResumeTarget precedence, pickCandidateByCwd :167 (reuse unchanged, refuse at :181-183), findCandidateSessions :191 (bounded today by a startedAtMs that does not exist for hand-started sessions — the new window replaces it), readSessionMeta :251 (64KB head read), isUuid :296, parseTimestampMs :302 (returns ms — convert)
- src/daemon.ts:3132-3143 — findLiveCodexStateJobs: how adopted rows join the live-state tailer once minted (resume_target set ⇒ tailed)

**Optional** (reference as needed):
- test/codex-resume.test.ts:50-70, :220 — rollout fixture builder + refuse-to-guess case to extend for originator-absent discovery
- src/reducer.ts SessionStart arm — the adopted field lands via task 1's plumbing; this task only binds it in the mint

### Risks

- Mis-attribution is the tail risk the gate exists for: the originator-absent-only predicate plus unchanged refuse-to-guess must never be widened here
- Backlog drain math: window and cap constants are tunable but the invariants (bounded scan, capped mints, knob re-read per tick) are acceptance-bound

### Test notes

Fixture-driven: originator-absent rollout alone in cwd → adopted (coordless, adopted-marked, ts from meta); two in one cwd → neither; keeper-originator rollout → skipped; stale-originator rollout → skipped; uuid already claimed → skipped; knob OFF → sweep never runs; cap honored across a seeded backlog; malformed head line → skipped without scan failure.

## Acceptance

- [ ] With the knob ON, a sole-unambiguous originator-less rollout becomes a coordless adopted job whose id and resume target are the rollout uuid and whose event time is the rollout's own session-start; it joins codex live-state tailing
- [ ] Ambiguous-cwd, keeper-originator, stale-originator, already-claimed, and unparseable rollouts are never adopted, and a scan failure never crashes the tick
- [ ] Discovery cost is bounded by the recency window, mints are capped per tick, and flipping the knob OFF stops adoption within one tick
- [ ] With the knob OFF nothing observable changes anywhere, and the codex fast suites pass with the new adoption coverage

## Done summary

## Evidence
