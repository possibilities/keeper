## Description

**Size:** M
**Files:** src/tabs-core.ts, src/restore-verify.ts, cli/tabs.ts, test/tabs.test.ts, test/restore-verify.test.ts

### Approach

Reproduce first (claims unverified): confirm that (a) the `isLive` gate at
`src/tabs-core.ts:383` short-circuits a candidate to `verified` with no
relaunch, and that the production impl (`cli/tabs.ts:1079`) defines "live" as
the durable verified-intent marker for this generation rather than actual
process liveness; and (b) the restore verify verdict (`applyRestoreVerified`
/ `AttachVerifyFn`) is point-in-time with no post-verify re-observation, so a
candidate that verifies then dies (the 17-way boot memory crunch) is masked
forever. Items 1 and 2 are two faces of one root — a past attach treated as
current liveness — so fix them together.

The fix gates the `isLive` no-op on a REAL current `(pid, start_time)` liveness
probe in addition to the intent marker, and replaces the single point-in-time
verdict with a dwell/startup-window check (process must stay alive across a
minimum dwell within a max window before being declared up). The liveness
probe MUST come through an injected start-time seam (see epic References),
never a direct `readOsStartTime` call, so the fast test tier stays subprocess-free.
If reproduction shows the restore intent record carries no `(pid, start_time)`
handle (`touchIntent` currently writes only state/reason/updated_at), persisting
that handle into the intent is the fix's first move — there is otherwise nothing
to probe against. When the probe itself fails/times out, choose and document a
fail-direction (a probe failure under the same memory crunch must not silently
mask a death, but must also not trigger a double-spawn).

### Investigation targets

*Verify before relying — planner-verified at authoring time, repo moves.*

**Required:**
- src/tabs-core.ts:362-460 — `applyRestoreVerified`; the `isLive` gate at :383; `touchIntent` :463 (intent carries no pid today)
- cli/tabs.ts:1079-1081 — production `isLive` = verified-intent-this-generation
- src/restore-verify.ts — `verifyAttach` / `AttachVerdict`, the evidence-gating seam
- src/seed-sweep.ts:99 — `readOsStartTime` (wrap in an injected seam, do not call directly)

**Optional:**
- src/exit-watcher.ts:403, src/agent/resume-policy.ts:185 — injected start-time seam precedent
- src/exec-backend.ts:485 — `parseGenerationId` `(pid, start_time)` identity

### Risks

- Dwell window lengthens each verdict; with 17 overlapping restores it must not blow up total latency — reconcile with `INTER_WINDOW_PAUSE_MS`.
- Intent-schema change (adding a pid handle) must stay backward-compatible with intents written before the change.

### Test notes

Extend `test/tabs.test.ts` (snapshot-script tests assert byte-aligned argv — sensitive to candidate shape) and `test/restore-verify.test.ts`. Inject a fake start-time/liveness dep; assert a die-after-verify candidate is re-observed dead. No real subprocess in the fast tier.

## Acceptance

- [ ] The `isLive` gate declares a candidate live only when a real current process-identity probe agrees, not on the verified-intent marker alone.
- [ ] A candidate that verifies and then dies is re-observed as dead (not a permanent no-op on re-run).
- [ ] Restore verify uses a dwell/startup-window check rather than a single point-in-time verdict.
- [ ] All liveness/start-time reads flow through an injected seam; the fast suite runs with no subprocess.
- [ ] A probe failure resolves to a documented fail-direction that neither masks a death nor double-spawns.

## Done summary
Gated the restore live-UUID no-op and the verify verdict on a REAL current (pid, start_time) probe instead of a past-attach marker: persisted the verified process's recycle-safe handle into the intent (backward-compatible, no schema bump), so a verified-then-died tab re-observes dead and relaunches; replaced the point-in-time verdict with a dwell/startup-window check; all liveness reads flow through injected seams (fast tier subprocess-free).
## Evidence
