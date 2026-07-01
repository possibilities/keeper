## Description

**Size:** M
**Files:** src/pair/panel.ts, test/pair-panel.test.ts, plugins/plan/agents/panel-runner.md, plugins/plan/agents/panel-judge.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/skills/panel/references/panel.md

### Approach

Repoint `pair panel` legs from `pair send` to detached `agent run` (task `.1`'s flags), and swap the terminality from `[keeper-pair]` log-scraping to result-file polling — keeping the pidfile crash-backstop and the verdict contract byte-stable.
- **Leg argv** (`buildPanelLegArgv`, `panel.ts:234`): `agent run --preset <m> --read-only --session panels --output <dir>/<m>.yaml --stop-timeout-ms <ms>` (translate the panel's `--timeout <s>` → ms panel-side; `1800s → 1_800_000ms`). `DETACH_SCRIPT` (`:273`) stays byte-identical — `agent run` writes the result file itself (`--output`), and `$LOG` keeps stderr/diagnostics for the crash-without-file case.
- **Wait** (`panelWait`, `:604`): keep the deadline/chunk/re-issue skeleton. `evaluateLeg` (`:367`): result file present → PARSE the JSON envelope → `outcome`: `completed` → `ok`; everything else (`no_message`/`timed_out`/`no_transcript`/`launch_failed`/`bad_args`) → `fail`, `reason = outcome`. Present-but-unparseable → treat as `fail` (`reason=corrupt-result`), never throw out of `wait`. Absent file + `pidAlive` dead past grace → `crashed`; else running. DELETE `scanLogTerminal` (`:306`), the `.log` log-scraping, and the "completed-but-no-file" contradiction branch (`:337`). KEEP `readPid`/`pidAlive`/grace (`:391-401`), `writeFileAtomic`, `parseManifest`, `resolvePanelMembers`. Manifest slims (drop `.log` if no longer needed; keep `.pidfile`); the poller matches ONLY the final `<m>.yaml` path, never a `.tmp`.
- **Verdict**: unchanged shape `{dir, ok, members:[{name,harness,status,yaml,reason}]}` — `yaml` holds the result-file PATH (now a JSON envelope), `reason` is the failure `outcome`.
- **Docs**: reword panel.ts JSDoc/`:228`, panel-runner.md (Step 2/3, `:139` reason, `:185` output), pair SKILL.md `## Panel fan-out` (`:154`/`:183`), panel.md `:31,34`, and panel-judge.md `:20` (answer file = JSON envelope with `message`) — all forward-facing.
- **Restore** a real-spawn detached-survival proof (the referenced-but-absent `test/pair-panel.slow.test.ts`, or an equivalent) so the blocking-`agent run` leg's detach-and-write property is covered; fix the stale JSDoc refs at `panel.ts`/`test/pair-panel.test.ts:9-10`.

### Investigation targets

**Required** (read before coding):
- src/pair/panel.ts:234 (`buildPanelLegArgv`), :273 (`DETACH_SCRIPT`), :288 (`writeFileAtomic`), :306 (`scanLogTerminal` — delete), :337 (contradiction branch — delete), :367-401 (`evaluateLeg`/`readPid`/`pidAlive` — rework/keep), :429 (`parseManifest`), :604 (`panelWait`), :104-118 (verdict types — keep), :88 (`PanelManifestMember` fields).
- src/agent/run-capture.ts:49-60 (envelope + `outcome` set the wait maps).
- plugins/plan/agents/panel-runner.md:59-67 (independence baked into the prompt body — why the dropped role is OK), :122-161 (verdict `.ok`/`.yaml`/`.reason` keys), :127-129/:145 (`PANEL_RUN_FAILED`).
- plugins/plan/agents/panel-judge.md:20 (answer-file expectation to update).

**Optional** (reference as needed):
- test/pair-panel.test.ts (fake spawn/clock/`pidAlive`; the log/pid tests to rewrite to seed result files; stale slow-test ref `:9-10`), src/agent/config.ts (`resolvePanelMembers` member→preset).

### Risks

- **`/plan:panel` end-to-end:** member resolution → fan-out → token-free wait → judge → fused answer must all still work; the verdict SHAPE stays byte-stable, and the judge answer-file (now JSON) still exposes `message`. This is the load-bearing user-facing surface — treat a broken panel as a hard fail.
- **Dropped role prompt:** panel-runner bakes independence into the prompt body, but `agent run` uses a raw `\n\n` directive join (no `assemblePrompt` `User:`/`System:` scaffold) — for codex/pi the delivery shape differs; confirm panelists still answer well (out-of-band smoke).
- **Outcome mapping** (`no_message`/`timed_out` → fail, whole-panel): a slow/empty panelist fails the whole panel — matches today's pair-send-timeout behavior; keep unless flipped.
- **Crash-without-file:** the pidfile backstop is the ONLY remaining crash signal; ensure the tracked pid owns the atomic write so "dead + no file" is a true crash, not a rename race.
- **`.tmp` visibility / partial JSON:** poller matches only the final path; unparseable-present → `fail`, not a throw.

### Test notes

Rewrite `test/pair-panel.test.ts`'s log/pid outcome tests to SEED result files (JSON envelopes with each `outcome`) instead of `.yaml`/`.log`/`.pidfile` sentinels; assert the outcome→verdict mapping (`completed`→ok; others→fail+reason), the corrupt-file→fail path, and the crash-without-file (dead pid + no file) path via the injected `pidAlive`. Keep all effects injected (spawn/clock/`pidAlive`/fs) — no real subprocess/tmux. Add/restore the real-spawn survival proof (slow tier). `/plan:panel` end-to-end is verified out-of-band.

## Acceptance

- [ ] `pair panel` legs are detached `agent run --preset <m> --read-only --session panels --output <m>.yaml --stop-timeout-ms <ms>` (panel translates `--timeout` s→ms); `DETACH_SCRIPT` unchanged.
- [ ] `panel wait` polls+parses result files: `completed`→ok, else→fail (`reason=outcome`), corrupt-present→fail, dead-pid+no-file→crashed; `scanLogTerminal` + the log-scraping deleted, the pidfile crash-backstop KEPT.
- [ ] Verdict shape `{dir, ok, members:[{name,harness,status,yaml,reason}]}` byte-stable; `panel-runner` + `PANEL_RUN_FAILED` unchanged; `/plan:panel` works end-to-end.
- [ ] `panel.ts` comments + panel-runner.md + panel-judge.md + pair SKILL.md + panel.md updated forward-facing (leg mechanism, reason sourcing, JSON answer file); the real-spawn survival test restored; stale JSDoc fixed.
- [ ] `bun test` green; no test launches a real subprocess/tmux/git.

## Done summary

## Evidence
