## Description

**Size:** M
**Files:** src/exec-backend.ts, cli/bus.ts, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md (+ sidecar via re-render), plugins/keeper/skills/bus/SKILL.md, README.md

### Approach

Add a `keeper bus wake planner@<epic>` verb that resumes the offline creator into a NEW dedicated `agentbus` tmux session, and auto-invoke it from `/work` Phase 2c. Depends on `.1` (the queued message must exist for the woken session to receive). **Window reaping/autoclose is OUT OF SCOPE** — the orthogonal cleanup system (the `investigate-keeper-cleanup` agent / fn-685) owns `agentbus` lifecycle; this task only spawns, and sets one marker so that reaper can find our windows (see step 6).

1. **Managed session constant.** Add `AGENTBUS_EXEC_SESSION = "agentbus" as const` to `src/exec-backend.ts` (mirror `MANAGED_EXEC_SESSION` `:115`).
2. **The wake verb (client-side).** In `cli/bus.ts`, add a `wake` arm to `parseBusArgv` (`:135-179`) + the run switch. Resolve the creator client-side: `parseRoleAddress` → `roleJobIds(db,"creator",epic)` → the `jobs` row for `cwd`+`title` (`resumeTarget` `src/resume-descriptor.ts:34-37`). Launch via `restoreReplayLaunch(AGENTBUS_EXEC_SESSION, argv, cwd, deps)` (`src/exec-backend.ts:737-761`). `buildResumeCommand` (`:60-67`) returns a SHELL STRING; `restoreReplayLaunch` takes `argv:string[]` — bridge by `bash -lc`-wrapping per `src/restore-worker.ts:322` / `scripts/restore-agents.ts:602` (verify first). Runs in the CLI process — NOT the bus socket, NOT a daemon RPC, NOT in `src/wake-worker.ts` (unrelated data_version pump — name-collision hazard).
3. **Gate the wake (anti-thrash, anti-double-spawn).** Per-session single-flight so concurrent escalations don't double-resume one creator (OS `flock` keyed on session id, mode 0600 under `$XDG_RUNTIME_DIR`/`$TMPDIR`, or equivalent in-process guard) — `has-session` alone is TOCTOU. Spawn-time liveness recheck: if the creator is now on the bus or `jobs.state` shows running, SKIP (a double `claude --resume` of a live id is the hazard — on doubt, don't resume). Cooldown/circuit-breaker after repeated failures, capped backoff. No idle-exit loop by construction — wake fires on a NEW escalation, never on the planner exiting.
4. **`/work` Phase 2c auto-invoke.** In `plugins/plan/template/skills/work.md.tmpl` Phase 2c (`:171-197`), on a `queued_for_wake` outcome: announce + auto-invoke `keeper bus wake planner@<epic>`, then YIELD (the woken planner re-arms `keeper bus watch`, the `.1` replay redelivers, its notification re-invokes the loop). Other non-`delivered` outcomes still fall back to surface-and-stop. Re-render via `keeper prompt render-plugin-templates`; commit `SKILL.md` + `.managed-file-dont-edit` sidecar together.
5. **Docs.** `plugins/keeper/skills/bus/SKILL.md` (wake verb + the two outcomes), `cli/bus.ts` HELP, README Agent Bus relay (+ the `agentbus` managed session, noting reaping is owned elsewhere).
6. **Managed-window marker (cleanup-system contract — REQUIRED).** On each `agentbus` spawn, set a tmux user-option marker on the spawned window so the external cleanup reaper can identify + reap OUR windows precisely (and never touch a human's hand-opened window in the session): `tmux set-option -w -t <paneId> @keeper_managed agentbus` (PROVISIONAL). The exact option name/value is owned by the orthogonal cleanup system — CONFIRM it with the `investigate-keeper-cleanup` agent (fn-685) before implementing; they will ping with the final spec. Without this marker, woken `agentbus` windows are never reaped. This is the ONLY reaping-related thing this task does — it sets the marker; it does NOT reap.

### Investigation targets

**Required:**
- src/exec-backend.ts:115 `MANAGED_EXEC_SESSION` (mirror), :737-761 `restoreReplayLaunch` + `RestoreReplayDeps` :720-724 (injectable `spawn`), :770-820 `launchIntoTmux` (get-or-create session + where a post-spawn `set-option -w` marker would attach to the spawned pane/window)
- src/resume-descriptor.ts:34-37 `resumeTarget`, :60-67 `buildResumeCommand` (SHELL STRING — wrap for argv)
- src/restore-worker.ts:322 + scripts/restore-agents.ts:602 — the shell-string→argv wrapping convention
- src/bus-identity.ts:240 `parseRoleAddress`, :257-287 `roleJobIds`, :306-338 `resolveRoleAddress`
- cli/bus.ts:135-179 `parseBusArgv` (+ `BusCommand` union :120-126), run switch, :350-364 stdin
- plugins/plan/template/skills/work.md.tmpl:171-197 Phase 2c; render seam `plugins/prompt/src/render_plugin_templates.ts` + `plugins/prompt/src/cli.ts`

**Optional / coordinate:**
- The `investigate-keeper-cleanup` agent (fn-685) — confirm the exact `@keeper_managed` marker option name/value before wiring step 6
- src/wake-worker.ts — DO NOT add bus-wake logic here (name collision)
- test/exec-backend.test.ts, test/resume-descriptor.test.ts, test/bus-cli.test.ts — fast-tier patterns (injected `spawn`/`now`)

### Risks

- TOCTOU double-spawn (single-flight per-session lock + EAFP on `new-session` — agentwrap launch is duplicate-session race-safe; recheck liveness before spawn).
- "Spawned but never connects" dead-wake: the `queued_for_wake` row stays and `/work` already fell back — acceptable v1; no busy-poll on the hot path.
- **Reaper marker is load-bearing**: the cleanup reaper keys on the `@keeper_managed`-style tmux user-option — our spawn MUST set it or woken windows never reap. Exact name/value pending cleanup-agent confirmation; don't guess — coordinate.
- Security: resume TARGET is trusted plan data (`epics.job_links` creator), never the sender's claim; validate the resolved id; bus authenticates the sender (peer-pid); lock file 0600.
- `restoreReplayLaunch` never throws (returns `{ok:false}`) — fail-open: a failed wake leaves the queued row + `/work` falls back.
- End-to-end resume→redeliver→act loop is unproven — acceptance includes a real integration check, not just unit tests.
- Autoclose/reaping itself is OUT OF SCOPE — do not extend the reaper or add a persist-config here.

### Test notes

Fast-tier: the wake verb resolves the creator + builds the correct `bash -lc` resume argv into session `agentbus` (injected `spawn`); the spawn path sets the managed-window marker (assert the `set-option -w … @keeper_managed` call shape, value per the confirmed spec); single-flight skips a second concurrent wake for the same session; liveness recheck skips a live creator; cooldown opens after K failures. `/work` Phase 2c is prose (verify rendered SKILL.md + sidecar committed together). The resume→redeliver→act loop needs a real integration check (slow tier or documented manual run).

## Acceptance

- [ ] `AGENTBUS_EXEC_SESSION` added; `keeper bus wake planner@<epic>` resolves the creator client-side and resumes via `claude --resume` (bash -lc-wrapped) into the `agentbus` session — not the bus socket, not a daemon RPC, not in `wake-worker.ts`
- [ ] Wake is single-flighted per session, skips an already-live creator, cooldown-gated; fail-open on launch failure
- [ ] Each `agentbus` spawn sets the cleanup system's managed-window marker (`@keeper_managed`-style tmux user-option, exact value confirmed with the investigate-keeper-cleanup agent) so the external reaper can identify+reap it
- [ ] `/work` Phase 2c auto-invokes the wake on `queued_for_wake` then yields; SKILL.md re-rendered + sidecar committed together
- [ ] Docs updated (bus SKILL.md, cli HELP, README) — forward-facing; autoclose/reaping noted as owned by the separate cleanup system
- [ ] fast-tier tests pass + an integration check of the resume→redeliver→act loop; `bun run test:full` green

## Done summary

## Evidence
