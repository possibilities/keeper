## Description

**Size:** M
**Files:** src/exec-backend.ts, cli/bus.ts, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md (+ sidecar via re-render), plugins/keeper/skills/bus/SKILL.md, README.md

### Approach

Add a `keeper bus wake planner@<epic>` verb that resumes the offline creator into a NEW dedicated `agentbus` tmux session, and auto-invoke it from `/work` Phase 2c. Depends on `.1` (the queued message must exist for the woken session to receive). **Autoclose/reaping is OUT OF SCOPE** — the orthogonal cleanup system owns `agentbus` window lifecycle; this task only spawns.

1. **Managed session constant.** Add `AGENTBUS_EXEC_SESSION = "agentbus" as const` to `src/exec-backend.ts` (mirror `MANAGED_EXEC_SESSION` `:115`).
2. **The wake verb (client-side).** In `cli/bus.ts`, add a `wake` arm to `parseBusArgv` (`:135-179`) + the run switch. It resolves the creator client-side: `parseRoleAddress` → `roleJobIds(db,"creator",epic)` → the `jobs` row for `cwd`+`title` (`resumeTarget` `src/resume-descriptor.ts:34-37`). Then it launches via `restoreReplayLaunch(AGENTBUS_EXEC_SESSION, argv, cwd, deps)` (`src/exec-backend.ts:737-761`). NOTE: `buildResumeCommand` (`:60-67`) returns a SHELL STRING (`cd … && claude --resume "<target>" --agentwrap-no-confirm`), and `restoreReplayLaunch` takes `argv:string[]` — bridge by `bash -lc`-wrapping per the existing `src/restore-worker.ts:322` / `scripts/restore-agents.ts:602` convention (verify it first). The verb runs the launch in the CLI process — NOT over the bus socket, NOT a daemon RPC, and NOT in `src/wake-worker.ts` (that module is the daemon's unrelated data_version pump — name-collision hazard).
3. **Gate the wake (anti-thrash, anti-double-spawn).** Per-session single-flight so two concurrent escalations don't double-resume one creator (an OS `flock` keyed on the session id, mode 0600 under `/run/user`/`$TMPDIR`, or an equivalent in-process guard) — `has-session` alone is TOCTOU. Spawn-time liveness recheck: if the creator is now connected on the bus or `jobs.state` shows it running, SKIP (a double `claude --resume` of a live id is the real hazard — on any doubt, don't resume). Cooldown after repeated failures (circuit-breaker) with a capped backoff. No idle-exit loop by construction — the wake fires on a NEW escalation, never on the planner exiting.
4. **`/work` Phase 2c auto-invoke.** In `plugins/plan/template/skills/work.md.tmpl` Phase 2c (`:171-197`), on a `queued_for_wake` send outcome: announce + auto-invoke `keeper bus wake planner@<epic>`, then YIELD (the woken planner re-arms `keeper bus watch`, the `.1` replay redelivers the escalation, its notification re-invokes the loop). A non-`delivered`/non-`queued_for_wake` outcome still falls back to surface-and-stop. Re-render via `keeper prompt render-plugin-templates` and commit `SKILL.md` + `.managed-file-dont-edit` sidecar together.
5. **Docs.** `plugins/keeper/skills/bus/SKILL.md` (wake verb + the two outcomes), `cli/bus.ts` HELP, README Agent Bus relay (+ the `agentbus` managed session, noting reaping is owned elsewhere).

### Investigation targets

**Required:**
- src/exec-backend.ts:115 `MANAGED_EXEC_SESSION` (mirror), :737-761 `restoreReplayLaunch` + `RestoreReplayDeps` :720-724 (injectable `spawn`), :770-820 `launchIntoTmux` (get-or-create session)
- src/resume-descriptor.ts:34-37 `resumeTarget`, :60-67 `buildResumeCommand` (SHELL STRING — wrap for argv)
- src/restore-worker.ts:322 + scripts/restore-agents.ts:602 — the existing shell-string→argv wrapping convention to follow
- src/bus-identity.ts:240 `parseRoleAddress`, :257-287 `roleJobIds`, :306-338 `resolveRoleAddress`
- cli/bus.ts:135-179 `parseBusArgv` (+ `BusCommand` union :120-126), the run switch, :350-364 stdin
- plugins/plan/template/skills/work.md.tmpl:171-197 Phase 2c; render seam `plugins/prompt/src/render_plugin_templates.ts` + `plugins/prompt/src/cli.ts` (`render-plugin-templates`)

**Optional:**
- src/wake-worker.ts — DO NOT add bus-wake logic here (name collision; it's the data_version pump)
- test/exec-backend.test.ts, test/resume-descriptor.test.ts, test/bus-cli.test.ts — fast-tier patterns (injected `spawn`/`now`)

### Risks

- TOCTOU double-spawn (single-flight per-session lock + EAFP on `new-session` — agentwrap's launch is already duplicate-session race-safe; recheck liveness before spawn).
- "Spawned but never connects" dead-wake: the `queued_for_wake` row stays and `/work` already fell back to surface-and-stop — acceptable for v1; do NOT add a busy-poll on the hot path.
- Security: the resume TARGET is trusted plan data (`epics.job_links` creator), never the sender's claim; validate the resolved id; the bus already authenticates the sender (peer-pid). Lock file 0600.
- `restoreReplayLaunch` never throws (returns `{ok:false}`) — fail-open: a failed wake leaves the queued row + `/work` falls back.
- The end-to-end resume→redeliver→act loop is unproven — make acceptance include a real integration check (or a documented manual verification), not just unit tests.
- Autoclose is OUT OF SCOPE — do not extend the reaper or add a persist-config here; coordinate the `agentbus` session name with the cleanup system if it changes.

### Test notes

Fast-tier: the wake verb resolves the creator + builds the correct `bash -lc` resume argv (injected `spawn`, assert argv + target session = `agentbus`); single-flight skips a second concurrent wake for the same session; liveness recheck skips when the creator is live; cooldown opens after K failures. `/work` Phase 2c is prose (no unit test) — verify the rendered SKILL.md + sidecar are committed together. The resume→redeliver→act loop needs a real integration check (slow tier or documented manual run).

## Acceptance

- [ ] `AGENTBUS_EXEC_SESSION` added; `keeper bus wake planner@<epic>` resolves the creator client-side and resumes via `claude --resume` (bash -lc-wrapped) into the `agentbus` session — not the bus socket, not a daemon RPC, not in `wake-worker.ts`
- [ ] Wake is single-flighted per session, skips an already-live creator, and cooldown-gated; fail-open on launch failure
- [ ] `/work` Phase 2c auto-invokes the wake on `queued_for_wake` then yields; SKILL.md re-rendered + sidecar committed together
- [ ] Docs updated (bus SKILL.md, cli HELP, README) — forward-facing; autoclose noted as owned by the separate cleanup system
- [ ] fast-tier tests pass + an integration check of the resume→redeliver→act loop; `bun run test:full` green

## Done summary

## Evidence
