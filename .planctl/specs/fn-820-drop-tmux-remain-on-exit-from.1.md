## Description

**Size:** S
**Files:** src/exec-backend.ts, src/restore-set.ts, docs/exec-backend.md, test/exec-backend.test.ts, README.md (conditional)

### Approach

Remove the chained `; set-option -p remain-on-exit on` tail (the last 5 argv elements) from `buildTmuxNewWindowArgs` in `src/exec-backend.ts`, so dispatched windows inherit the global `remain-on-exit off` and close natively when their whole process tree exits. Then rewrite every comment/doc the removal falsifies to describe the CURRENT steady state: the launch wrapper's trailing `exec $SHELL -l -i` login shell keeps the pane occupied after the hosted `claude` process exits, so `classifyCloseKind`'s `tmux list-panes` probe still returns `pid_died` (the pane is listed because the shell holds it), and `window_gone_server_alive` still means the pane is gone. Forward-facing only — describe the trailing-shell mechanism as the steady state; never narrate "we removed remain-on-exit". NO `classifyCloseKind` logic change, NO seed-sweep change, NO auto-reaper. Update the test, and verify the README wording before touching it.

Accepted tradeoff (mention in passing, do NOT engineer around it): an isolated whole-process-GROUP death (cgroup/OOM or `kill -9 -<pgid>` taking claude AND the trailing shell at once) that spares the tmux server and is missed by the live watcher classifies `window_gone_server_alive` instead of `pid_died`, dropping it from crash-restore's auto-offer (recoverable by hand). Reboots stay `server_gone` → still restored; ordinary claude crashes self-heal via the trailing shell → still `pid_died`.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:259-263 — the 5-element `";","set-option","-p","remain-on-exit","on"` tail to delete (keep everything through `...argv`)
- src/exec-backend.ts:188-191, 220-224, 230-232, 350, 437, 466 — comments falsified by the removal; rewrite to the trailing-shell mechanism (the :350 / :437 `pid_died` docs must explain WHY `pid_died` is still reachable, not just drop the old clause)
- src/restore-set.ts:15 — the `pid_died` gloss ("died under remain-on-exit")
- docs/exec-backend.md:245 — remove the "chained `set-option -p remain-on-exit on`" clause from the argv table cell
- test/exec-backend.test.ts:140-177 — remove the 5 trailing argv entries from the `toEqual([...])`, fix the test name at :140 ("...chained `;` set-option..."), and remove/invert the `;`-count assertions at :172-176
- plugin/hooks/events-writer.ts:624 and src/autopilot-worker.ts:657-676 — context: claude-pid tracking + the `exec $SHELL` wrapper are why `pid_died` still holds

**Optional** (reference as needed):
- README.md ~340-343, ~2351-2366 — verify the "stays open for inspection" prose; the trailing shell still holds the pane after claude exits and only a full-tree exit closes natively, so touch ONLY what is genuinely false
- src/autopilot-worker.ts:657-664 — the "rare auto-close miss" comment; touch only if it now reads false

## Acceptance

- [ ] `buildTmuxNewWindowArgs` argv ends at `...argv` — no `set-option` / `remain-on-exit` tail
- [ ] Every rewritten comment/doc describes the current trailing-shell mechanism (forward-facing, no change-history); the `pid_died` docs still explain why it is reachable
- [ ] `test/exec-backend.test.ts` argv assertion, test name, and `;`-count assertions updated; targeted test green
- [ ] `grep -rn "remain-on-exit" src/ docs/ test/` returns nothing (only historical `.planctl/` specs retain it)
- [ ] README "stays open for inspection" prose verified; updated only where genuinely falsified
- [ ] `bun run test:full` passes
- [ ] Landed via `keeper commit-work`

## Done summary
Dropped the chained remain-on-exit on tail from buildTmuxNewWindowArgs so dispatched windows close natively on full-tree exit; the trailing exec $SHELL login shell keeps the pane listed so classifyCloseKind still reads pid_died. Rewrote falsified comments/docs to the trailing-shell mechanism. Full suite green.
## Evidence
