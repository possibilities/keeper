## Description

**Size:** M
**Files:** src/agent/tmux-launch.ts (defaultKeeperAgentStateDir), src/agent/cwd-ordinal.ts (the hardcoded stateDir + the rename chokepoint), src/agent/main.ts (state-dir wiring), test/fixtures/keeper-agent-launch-stdout.jsonl (content path), scripts/frozen-allowlist.txt (remove state-dir anchor), test/agent-cwd-ordinal.test.ts + related

### Approach

Relocate `~/.local/state/agentwrap/` → `~/.local/state/keeper-agent/` via an INODE-PRESERVING ATOMIC DIRECTORY RENAME (NOT a copy-forward shim — flock binds the inode, so copy-forward would fork the lock and silently diverge the cwd-ordinals counter). First UNIFY the two divergent state-dir functions into one XDG-honoring source: `defaultKeeperAgentStateDir` (tmux-launch, honors `XDG_STATE_HOME`) and cwd-ordinal.ts's separate hardcoded `stateDir()` (does NOT honor XDG) must resolve the SAME path, else the rename target is ambiguous. Point both at `~/.local/state/keeper-agent/` (XDG-honoring). Add a one-time guarded migration at a single chokepoint that runs BEFORE any new-path mkdir/flock: if the new dir is absent and the old exists, `rename(old,new)`; tolerate `ENOENT` (another launch already migrated) and a non-empty/`EEXIST` new dir (new wins — do NOT unlink+recreate the lock file). Preserve the flock discipline (src/usage-flock.ts; open `a+` non-truncating, `setCloexec` before `LOCK_EX`, fail-open→ordinal 1). Update the fixture's content path (`~/.local/state/agentwrap/tmux-runs` → keeper-agent) and remove the state-dir anchor from frozen-allowlist.txt. Grep fresh post-fn-1018 (the function is `defaultKeeperAgentStateDir` after fn-1018.2 renames it); line numbers illustrative.

### Investigation targets

**Required** (read before coding):
- src/agent/tmux-launch.ts:~360 `defaultKeeperAgentStateDir` (XDG-aware) + the tmux-runs consumers
- src/agent/cwd-ordinal.ts — the second hardcoded `stateDir()` + the flock counter discipline to preserve + the lazy `mkdirSync(stateDir())` that is the migration-chokepoint concern
- src/usage-flock.ts — `FLOCK_CONSTANTS`/`flockFd`/`setCloexec` to reuse
- src/agent/main.ts:~246 — the deps state-dir injection; src/agent/pair-subcommands.ts — run.json resolution (another consumer)
- scripts/frozen-allowlist.txt — the state-dir anchor to remove

**Optional** (reference as needed):
- test/fixtures/keeper-agent-launch-stdout.jsonl — the content path to update

### Risks

- flock split-brain: ONLY an atomic dir rename preserves the inode; never copy-forward, never unlink+recreate the lock file.
- Two-dir divergence: if `XDG_STATE_HOME` is set the two functions point at different dirs — unify FIRST so there is exactly one old→new mapping; the rename must target the dir where cwd-ordinals.json actually lives.
- Chokepoint: `mkdirSync(stateDir())` is called lazily per cwd-ordinal call — the rename must run before any new-path mkdir, else a fresh empty new-dir strands the old counter and the rename hits `ENOTEMPTY`.
- Concurrent launches racing the rename: tolerate `ENOENT` (already migrated) and `EEXIST`/`ENOTEMPTY` (new wins).

### Test notes

Tests cover: rename migrates old→new preserving the counter value; new-present skips the rename; `ENOENT`/`EEXIST` tolerated; the unified stateDir honors `XDG_STATE_HOME` consistently across both call sites. `bun test` green; lint green (state-dir anchor removed).

## Acceptance

- [ ] The two stateDir functions unified to one XDG-honoring source resolving `~/.local/state/keeper-agent/`
- [ ] One-time guarded atomic `rename(old,new)` at a single chokepoint before any new-path mkdir/flock; `ENOENT` + `EEXIST` tolerated; no unlink+recreate
- [ ] The flock-guarded cwd-ordinals counter value survives the relocation (test-proven)
- [ ] Fixture content path updated; state-dir anchor removed; `bun test` + lint green

## Done summary

## Evidence
