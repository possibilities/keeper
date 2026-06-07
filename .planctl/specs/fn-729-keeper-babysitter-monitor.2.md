## Description

**Size:** M
**Files:** cli/keeper-watch.ts, test/keeper-watch.test.ts

Add the `--tick` launchd entry on top of the .1 detection core: dedup findings
against a persistent seen-state file, and on genuinely-new findings spawn the
headless babysitter agent safely, committing seen-state only on success.

### Approach

`--tick` flow: scan (reuse .1 detectors) → load seen-state → compute NEW findings
(key/fingerprint not in seen-state) → if none, exit 0 silently → else write the
frozen findings snapshot to a temp JSON and spawn the agent → on agent exit 0,
merge delivered findings into seen-state.

**seen-state** lives at `~/.local/state/keeper-watch/seen.json` (its OWN dir —
NOT a `KEEPER_*` path; env-overridable resolver mirroring `resolveDbPath`'s
shape). Schema per fingerprint: `{ first_seen, last_seen, notification_count,
last_notified_at }`. Atomic write-then-rename (write `.tmp`, `renameSync` over
target) — never open 'w'. Load-with-fallback: corrupt/missing → empty.

**Cold start / corrupt** = silent baseline: seed all current findings as seen
and notify nothing (no spawn). Only a genuinely-new finding after a valid
baseline escalates.

**Held-across-ticks** signals finalize here using seen-state history:
reducer-wedge fires only if lag persists ≥N consecutive ticks; dead-letter-growth
fires on a positive delta vs the stored baseline count; autopilot-stall requires
the unpaused-no-dispatch condition held ≥N ticks.

**Cooldown**: re-notify a still-present finding only if `now - last_notified_at >
COOLDOWN` (~1h default); TTL-prune entries unseen >24h. Per-fingerprint retry cap
so a permanently-failing spawn doesn't re-attempt every tick forever.

**Agent spawn** (`Bun.spawn`): invoke the PLAIN claude binary
(`/Users/mike/.local/bin/claude`, verified NOT the `arthack-claude.py` wrapper —
keeps keeper hooks unloaded so the monitor doesn't pollute the board), cwd =
repo root (so the project agent resolves), `-p "Use the keeper-babysitter agent
to triage the findings in <tmpfile> and notify me of anything noteworthy."
--permission-mode bypassPermissions`. Hard timeout via `AbortController`
(default 240s < the 300s interval); kill on expiry. `await proc.exited` (no
zombie; never `nohup &`). Redirect agent stdout/stderr to a log under the
watcher state dir. The agent writes back delivered finding keys (ack file under
the state dir); tick commits those — fallback: exit 0 + no ack → commit all
handed; non-zero/timeout → commit none (retry next tick within the cap).

### Investigation targets

**Required** (read before coding):
- cli/keeper-watch.ts — the .1 detectors + `Finding` shape this builds on
- src/db.ts:69 — `resolveDbPath` resolver shape to mirror for the seen-state path

**Optional** (reference as needed):
- plist/arthack.keeperd.plist — confirms the launchd PATH the spawn inherits

### Risks

- Hung `claude -p` blocks all future ticks (interval resets from exit) — the hard
  timeout + kill is the mitigation; test it.
- Partial delivery on timeout → storm — cooldown + per-finding ack commit bound it.
- Accidentally resolving the wrapper binary → keeper-hook pollution — pin + verify the absolute plain path.
- seen.json is a trust boundary — dir writable only by the user.

### Test notes

Unit-test the dedup diff (seen vs current), atomic write survives a simulated
crash (tmp left, target intact), cold-start baselines without spawning, cooldown
suppresses within window, retry cap halts re-spawn. Stub the spawn (injectable)
so no real `claude` runs in tests. Same five-path sandbox rule.

## Acceptance

- [ ] `--tick` exits 0 silently when no new findings
- [ ] First run / corrupt seen.json baselines silently (no spawn, no notify)
- [ ] seen.json written atomically (tmp + rename); corrupt load falls back to empty
- [ ] reducer-wedge / dead-letter-growth / autopilot-stall use held-across-ticks / delta logic
- [ ] Agent spawn uses the verified PLAIN claude path, hard-timeout-killed before 300s, awaited (no zombie)
- [ ] seen-state commits only delivered findings on success; nothing on timeout/non-zero; per-fingerprint retry cap enforced
- [ ] Cooldown (~1h) prevents re-notify storms; TTL prune drops stale entries
- [ ] spawn is injectable; tests run no real claude; all five `KEEPER_*` paths sandboxed
- [ ] `bun run lint`, `bun run typecheck`, `bun run test:fast` pass

## Done summary
Added the --tick launchd escalation flow on top of the .1 detection core: seen-state dedup (own dir, atomic write, corrupt/missing -> silent baseline), held-across-ticks / delta finalizers, cooldown + TTL prune + per-fingerprint retry cap, and an injectable hard-timeout-killed headless spawn of the PLAIN claude binary that commits only delivered findings on success. Added arthack.keeper-watch.plist (StartInterval 300, no KeepAlive) and 33 new unit tests.
## Evidence
