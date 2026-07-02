## Description

**Size:** M
**Files:** src/agent/codex-session-index.ts, src/agent/run-capture.ts, src/agent/transcript-watch.ts, src/agent/launch-handle.ts, test/agent-run-capture.test.ts

### Approach

Reproduce first from the live evidence: panel slug verify-stab-smoke's codex leg (launched ~22:48:02) captured ~/.codex/sessions/2026/07/01/rollout-2026-07-01T22-45-46-….jsonl (created 2.3 minutes BEFORE launch, still being written by a concurrent human session in the same cwd) while the leg's own rollout-2026-07-01T22-48-06-….jsonl sat beside it. Then harden the discovery chain — the codex transcript locate (src/agent/transcript-watch.ts codex arm), the session index (src/agent/codex-session-index.ts), and the resume-target seam (src/agent/run-capture.ts:428-436) — so a leg binds only to a rollout it can positively attribute: minimum floor is rejecting any candidate whose file creation predates the leg's launch instant (the leg records launched_at; codex rollout filenames embed their creation timestamp, parseable without opening the file); prefer a positive identity check where feasible (the rollout's embedded session/thread id vs what the leg's launch observed, or content markers the leg's own prompt uniquely carries). When zero candidates survive, or more than one does, the capture must return a DISTINCT non-completed outcome (transcript-ambiguous, mirroring the envelope's existing failure taxonomy) instead of guessing — a wrong-but-confident answer is the worst outcome, as this incident shows. Codex cannot pin a session id at spawn (src/agent/launch-handle.ts:54-72 documents the asymmetry) — do not fake one; strengthen attribution evidence instead.

### Investigation targets

**Required** (read before coding):
- src/agent/codex-session-index.ts — the whole index: what it keys on, how candidates rank
- src/agent/run-capture.ts:428-436 — the codex resume-target discovery seam
- src/agent/transcript-watch.ts (codex arm ~:217) — locate/stop/last-message parsing
- src/agent/launch-handle.ts:54-72 — the session-pin asymmetry the fix must respect

## Acceptance

- [ ] Pre-launch-dated rollouts are rejected; concurrent-session collision yields a distinct non-completed outcome, never a foreign answer
- [ ] The leg's own rollout is found in the two-file live scenario (regression test with fabricated rollout fixtures)
- [ ] Full fast suite green

## Done summary

## Evidence
