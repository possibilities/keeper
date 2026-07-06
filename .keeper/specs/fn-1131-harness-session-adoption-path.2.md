## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/hermes-events-shim.ts, test/hermes-shim.test.ts

### Approach

When KEEPER_JOB_ID is absent, the shim self-seeds instead of returning null: every event line is emitted under the harness-native session id as the job id (charset-whitelisted and length-bounded on the RAW value before use — it becomes a job_id that flows into path-bearing surfaces; reject → fall back to today's null), with harness=hermes, resume_target=native id on SessionStart, cwd, the adopted field, and FULL backend-exec coordinates (session/window/pane) replicated from the claude hook's coord logic — carrier env first, raw tmux env fallback for hand launches, absent-outside-tmux tolerated (a coordless adopted hermes job is legal and reported by restore like any coordless adopted job). Coords ride EVERY line, not just SessionStart, because restore's coordinates fold from the every-event arm. When KEEPER_JOB_ID is present, behavior is byte-identical to today (launcher-owned XOR). A local opt-out env var disables self-seeding only (fail-open, presence-gated, documented in the shim header) — the consent posture for capturing sessions the human started outside keeper. The shim stays a dep-free island: replicate coord logic inline with the established drift-guard comment pair, never import the DB graph; one bounded JSON line, exit 0, no host stdout. A lost self-seed line before SessionStart means that session stays untracked until its next SessionStart-bearing lifecycle — an accepted v1 limitation, stated in the shim header.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/hermes-events-shim.ts:122-190 — buildHermesEventLine: the null-gate :127-132 to replace, session_id stamping :160, SessionStart harness/resume_target :181-187, cwd-only env read :173; ts producer-stamp call site :281
- plugins/keeper/plugin/hooks/events-writer.ts — backendExecCoordsFromEnv: the full session/window/pane extraction to replicate inline (carrier-first, raw fallback)
- src/birth-record.ts:226-249 — birthBackendCoordsFromEnv: the existing drift-guard replication pair and its comment discipline
- test/hermes-shim.test.ts:24, :186 — env() helper, golden-line tests; the "empty job id → null" case inverts to "→ self-seeded line", goldens update for the new shape

**Optional** (reference as needed):
- src/agent/main.ts:2573 — pi's native-id-as-job-id precedent
- src/hermes-trust.ts:240-280 — how the shim is persistently registered (why it already fires for hand-started sessions)

### Risks

- Coord replication drift: the inline copy must carry the drift-guard comment pair so future coord changes update both sites
- The charset gate is load-bearing security (native id is attacker-influenceable input becoming a path-bearing job id) — reject-to-null, never sanitize-and-continue

### Test notes

Golden-line cases: absent KEEPER_JOB_ID + native id → full self-seeded SessionStart line (id, resume_target, adopted, coords); present KEEPER_JOB_ID → byte-identical to current goldens; opt-out env set → null; hostile native id (traversal, NUL, overlong) → null; outside-tmux → line without coords. Pure tests, injected env, fixed ts.

## Acceptance

- [ ] A hand-started hermes session in tmux produces events-log lines that fold into a tracked jobs row under its native session id with the adopted marker, resume target, cwd, and full backend coordinates — and its live state updates on subsequent events
- [ ] A launcher-started hermes session's lines are byte-identical to today's, and the opt-out env suppresses self-seeding without affecting launcher-owned lines
- [ ] A hostile or malformed native session id never becomes a job id (line degrades to null), and every emitted line stays one bounded JSON line
- [ ] The shim suite passes with updated goldens covering all self-seed branches

## Done summary

## Evidence
