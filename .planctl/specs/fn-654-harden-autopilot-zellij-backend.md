## Overview

Now that zellij is the standing `DEFAULT_EXEC_BACKEND` and autopilot workers
survive autopilot restarts under a long-lived `zellij --server`, simplify and
harden the terminal-surface backend in three moves: (1) delete the unused
Ghostty/osascript backend so zellij is the only `ExecBackend`; (2) switch the
auto-close path from whole-tab `close-tab-by-id` to surgical pane-level
`close-pane -p <paneId>`, guarded by a server-generation token so a stale
pane id from a `dispatch.log` hydrated across a zellij-server restart can
never reap the wrong live pane; (3) make `dispatch.log` actually survive
restarts so the durable `dispatchedKeys` re-dispatch guard works (the in-repo
code is already append-only — the truncation source is external and must be
located first). End state: one backend, surgical pane reaping that leaves
human-added panes alone, and a forensic log that persists across restarts.

## Quick commands

- `bun test test/exec-backend.test.ts test/config.test.ts test/autopilot.test.ts` — full client-side suite green after each task
- `bunx tsc --noEmit` — typecheck clean (Ghostty type-narrowing + pane-id return)
- `zellij --version` — confirm 0.44.3 (the version close-pane -p was verified against)
- `stat -f '%SB' ~/.local/state/keeper/dispatch.log` — birth time should predate the latest autopilot start once piece 3 lands

## Acceptance

- [ ] Ghostty backend fully removed from `src/exec-backend.ts`; `resolveExecBackend` is zellij-only; `exec_backend` config key dropped from `KeeperConfig`/`resolveConfig`; Ghostty tests + the CLAUDE.md Ghostty-OOM block deleted; tsc + all suites green.
- [ ] Autopilot auto-close reaps only its own pane via `close-pane -p <paneId>`; a tab the human split another pane into survives; the fresh-mint orphan default-tab reap still works.
- [ ] A pane id hydrated from `dispatch.log` is only auto-closed when its server-generation token matches the live server; a mismatched or token-less (pre-upgrade) row is skipped, never reaped.
- [ ] The real `dispatch.log` truncation source is identified and `dispatch.log` provably persists across an autopilot restart (re-dispatch guard hydrates non-empty).
- [ ] The just-shipped zellij `isSurfaceLive` name-exact gate (8ef4371) and `autoclose_windows` config (c231506) are NOT regressed.

## Early proof point

Task that proves the approach: `harden-autopilot-zellij-backend.2` (surgical
pane-close + generation-token guard) — it carries the load-bearing close
semantics and the wrap-safety design. If it fails (e.g. 0.44.3 `close-pane -p`
doesn't behave as source-verified, or no stable generation token is exposed
headlessly): fall back to keeping `close-tab-by-id` but gating auto-close on
the name-exact `isSurfaceLive` check at close time (reuse the 8ef4371
machinery) so a stale id can't reap a live surface.

## References

- zellij 0.44.3 `close-pane -p <PANE_ID>` verified against installed binary + source (`zellij-server/src/screen.rs:2518-2523`): a tab auto-closes only when it has zero selectable TILED panes left — surgical by construction, no pre-close guard query needed. Floating panes do NOT count.
- Pane ids (`terminal_<n>`) are a process-global monotonic `AtomicU32`, never reused within a server lifetime but reset across a server restart — the wrap hazard the generation token closes.
- CLAUDE.md blesses the two-field `(pid, start_time)` identity as the recycle-proof guard (the `Killed` fold precedent) — the idiomatic candidate for the server-generation token.
- fn-652 double-spawn fix (commit 8ef4371): the zellij `isSurfaceLive` gate must not be weakened by the Ghostty delete.
- Bun issue #3395: `createWriteStream({flags:'a'})` truncated despite append flag — do NOT switch dispatch.log to a write stream; the current per-call `appendFileSync` (O_APPEND|O_CREAT) is correct.

## Docs gaps

- **README.md** (config block ~252-290): `exec_backend` key documents two values + ghostty prose + "Ignored when exec_backend: ghostty" on `zellij_session` — collapse to zellij-only or delete the key; drop `exec_backend: zellij` from the sample YAML.
- **README.md** (architecture/autopilot ~550-557): names both backends and describes close as `close-tab-by-id` — drop the ghostty branch, describe `close-pane -p`, note `launch` returns a pane id.
- **README.md** (dispatch.log description ~554-555): note append-across-restarts semantics + that the id is now a pane id.
- **CLAUDE.md**: delete the entire "Known issue: autopilot Ghostty surface-init OOM" block (~506-535) cleanly, no stub heading — dead text once Ghostty is gone.

## Best practices

- **close-pane -p is pane-scoped by construction:** no pre-close `list-panes` guard is needed for the "shared tab survives" case — zellij only auto-closes a tab with zero selectable tiled panes. [zellij source verified]
- **Don't switch dispatch.log to createWriteStream:** the append-flag truncation bug (Bun #3395) means per-call `appendFileSync` is the safe primitive; JSONL lines are well under PIPE_BUF so O_APPEND atomicity holds.
- **Stale-id closes fail safe:** `close-pane -p` against an unknown id no-ops via stderr→noteLine (existing fire-and-forget close contract) — but a recycled id after a server restart is the one case that can reap a LIVE pane, which the generation-token guard exists to prevent.
