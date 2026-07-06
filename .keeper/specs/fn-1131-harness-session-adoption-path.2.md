## Description

**Size:** M
**Files:** plugins/keeper/plugin/hooks/hermes-events-shim.ts, test/hermes-shim.test.ts

### Approach

When KEEPER_JOB_ID is absent, the shim self-seeds instead of returning null: every event line is emitted under the harness-native session id as the job id (charset-whitelisted and length-bounded on the RAW value before use — it becomes a job_id that flows into path-bearing surfaces; reject → fall back to today's null), with harness=hermes, resume_target=native id on SessionStart, cwd, the adopted field, and FULL backend-exec coordinates (session/window/pane) replicated from the claude hook's coord logic — carrier env first, raw tmux env fallback for hand launches, absent-outside-tmux tolerated (a coordless adopted hermes job is legal and reported by restore like any coordless adopted job). Coords ride EVERY line, not just SessionStart, because restore's coordinates fold from the every-event arm. When KEEPER_JOB_ID is present, behavior is byte-identical to today (launcher-owned XOR). A local opt-out env var disables self-seeding only (fail-open, presence-gated, documented in the shim header) — the consent posture for capturing sessions the human started outside keeper. The shim stays a dep-free island: replicate coord logic inline with the established drift-guard comment pair, never import the DB graph; one bounded JSON line, exit 0, no host stdout. A lost self-seed line before SessionStart means that session stays untracked until its next SessionStart-bearing lifecycle — an accepted v1 limitation, stated in the shim header.

**Session pid, not shim pid.** The shim is a short-lived hook child of the hermes process, so its own pid varies per invocation and must never be the adopted row's process identity — self-seeded lines carry the SESSION pid via the shim's parent pid, and the task verifies end-to-end which pid the jobs fold lands from this path so the adopted row is neither insta-reaped by the pidless reap arm nor resurrected onto a recycled pid. Decide the pid-reuse witness for adopted rows at implementation time against the exit-watcher's existing identity-guarded reap (the launcher path pairs pid with start_time; the adopted path needs an equivalent witness — a start-time field on the self-seeded SessionStart or a native-id re-probe before reap). Clean exits need no inference: hermes emits its stop lifecycle through this same shim, so an adopted row stops like a launched one; the pid+witness story exists for hard-kill reaping only.

**Versioned records, staged rollout.** Bump HERMES_SHIM_VERSION with the contract change, and stamp the shim version on self-seeded lines so the daemon can branch on old-shim records (additive-only evolution: the ingest surface must keep accepting version-less lines from stale shims). State the rollout lag in the shim header as an accepted limitation: a persistently-seeded OLD shim keeps firing for hand-started sessions until a keeper-launched hermes re-seeds the config block AND the hand session restarts.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/hermes-events-shim.ts:122-190 — buildHermesEventLine: the null-gate :127-132 to replace, session_id stamping :160, SessionStart harness/resume_target :181-187, cwd-only env read :173; ts producer-stamp call site :281; HERMES_SHIM_VERSION :96
- plugins/keeper/plugin/hooks/events-writer.ts — backendExecCoordsFromEnv: the full session/window/pane extraction to replicate inline (carrier-first, raw fallback); ALSO trace which pid field the claude path stamps and how it reaches jobs.pid — the semantics the self-seeded line must mirror with the session (parent) pid
- src/birth-record.ts:226-249 — birthBackendCoordsFromEnv: the existing drift-guard replication pair and its comment discipline; :57-61 the (pid, start_time) recycle-safety pairing the adopted witness must answer to
- src/exit-watcher.ts:1-55 + src/daemon.ts:5463-5500 — the candidate set (state IN working/stopped, no pid filter), the pidless-reap-on-sight arm, and the identity-guarded reap an adopted row must survive correctly
- src/hermes-trust.ts:240-280 — how the shim is persistently registered (why it already fires for hand-started sessions) and how HERMES_SHIM_VERSION gates the managed-block re-seed
- test/hermes-shim.test.ts:24, :186 — env() helper, golden-line tests; the "empty job id → null" case inverts to "→ self-seeded line", goldens update for the new shape; test/hermes-trust.test.ts asserts the version import

**Optional** (reference as needed):
- src/agent/main.ts:2573 — pi's native-id-as-job-id precedent
- src/daemon.ts:2954 — the NULL-pid boot_unwatchable reap warning that makes the session-pid capture load-bearing

### Risks

- Coord replication drift: the inline copy must carry the drift-guard comment pair so future coord changes update both sites
- The charset gate is load-bearing security (native id is attacker-influenceable input becoming a path-bearing job id) — reject-to-null, never sanitize-and-continue
- Wrong-pid capture is the zombie/insta-reap axis: a per-invocation shim pid on the row breaks the exit-watcher both ways; the parent-pid capture plus witness is the fix, and it must be verified against the reap arms, not assumed
- Old seeded shims persist through the rollout — version-less lines keep arriving and must keep ingesting

### Test notes

Golden-line cases: absent KEEPER_JOB_ID + native id → full self-seeded SessionStart line (id, resume_target, adopted, coords, session pid, shim version); present KEEPER_JOB_ID → byte-identical to current goldens; opt-out env set → null; hostile native id (traversal, NUL, overlong) → null; outside-tmux → line without coords; same native id re-seeded (replayed lifecycle) → identical id, no divergent identity. Pure tests, injected env + injected parent pid, fixed ts.

## Acceptance

- [ ] A hand-started hermes session in tmux produces events-log lines that fold into a tracked jobs row under its native session id with the adopted marker, resume target, cwd, full backend coordinates, and the SESSION process pid — and its live state updates on subsequent events
- [ ] The adopted row survives the reap arms correctly: it is not pidless-reaped on sight, a clean hermes exit stops it through the shim's own lifecycle events, and the hard-kill reap path has a stated pid-reuse witness
- [ ] A launcher-started hermes session's lines are byte-identical to today's, and the opt-out env suppresses self-seeding without affecting launcher-owned lines
- [ ] Self-seeded lines carry the shim version, version-less lines from stale shims still ingest, and the shim version constant is bumped with the trust-seed test green
- [ ] A hostile or malformed native session id never becomes a job id (line degrades to null), and every emitted line stays one bounded JSON line
- [ ] The shim suite passes with updated goldens covering all self-seed branches

## Done summary
Hermes shim self-seeds a hand-started session as an adopted, tracked jobs row under its charset-validated native id — adopted marker, session (parent) pid on every line, (pid,start_time) recycle witness on SessionStart, full backend coords, shim-version stamp; KEEPER_HERMES_NO_ADOPT opt-out gates only the self-seed path; launcher-owned lines byte-identical. Bumped HERMES_SHIM_VERSION to 2.
## Evidence
