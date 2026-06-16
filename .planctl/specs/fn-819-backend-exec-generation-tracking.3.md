## Description

**Size:** M
**Files:** cli/setup-tmux.ts, test/setup-tmux.test.ts

Wire `keeper setup-tmux` to offer a foreground-only restore of the last generation's crashed agents when the foreground session is absent.

### Approach

In `main`, BEFORE `rebuildDash`/`ensureWorkSessions` (which create a NEW tmux server = a new generation), and after the kill-sessions block: probe `has-session foreground`. If it EXISTS → skip the offer entirely (one-shot: only the first setup-tmux after a crash offers). If absent → compute the generation-scoped foreground candidate set. setup-tmux stays OUTSIDE the ExecBackend seam, but reading keeper.db is not ExecBackend — open keeper.db read-only and call `deriveLastGenerationSet` filtered to `backend_exec_session_id === 'foreground'` for the COUNT (inject this provider for tests). Empty → skip silently. Non-empty AND TTY → prompt via the existing `confirm()` pattern: `Restore N agent(s) from the last 'foreground' session? [y/N]`. Non-TTY → skip (never auto-restore). On yes → after `ensureWorkSessions`, spawn `bun scripts/restore-agents.ts --apply --session foreground --last-generation` via the injectable `SyncSpawnFn` seam (the subprocess owns ExecBackend; setup-tmux does not import it).

### Investigation targets

**Required** (read before coding):
- cli/setup-tmux.ts:485-543 `main` (offer goes between the kill block :529 and `rebuildDash` :531), :439-446 `ensureWorkSessions` (mints foreground — probe has-session BEFORE), :125-127 `buildHasSessionArgs`, :472-483 `confirm()`, :511-512 TTY gate, :92-103 `SyncSpawnFn`/`defaultSpawn`, :10-13 the "outside ExecBackend" design note
- src/restore-set.ts `deriveLastGenerationSet` (from T2) + src/db.ts `openDb(path,{readonly:true})`
- scripts/restore-agents.ts — the `--apply --session foreground --last-generation` invocation contract

### Risks

- Ordering: the candidate set MUST be computed before any session-creating call, else the freshly-minted foreground server becomes the "current" generation and shifts the window. Probe + count before `rebuildDash`.
- setup-tmux gains a readonly keeper.db dependency (it had none) — keep it injectable so tests don't need a real DB; the action stays a spawned subprocess (no ExecBackend import).
- Non-TTY must skip, not auto-yes.

### Test notes

setup-tmux test (mirror :380-488 — isTTY defineProperty save/restore + EOF-confirm): inject a candidate-count provider + a capturing `SyncSpawnFn`; assert the offer prompts only when foreground absent AND count>0 AND TTY; assert a `y` spawns `restore-agents ... --last-generation` with the right argv; assert foreground-present and non-TTY both skip without spawning.

## Acceptance

- [ ] Offer fires only when `foreground` is absent, last-generation foreground candidates exist, and stdin/stdout are a TTY; computed before any session-creating call.
- [ ] `y` spawns `bun scripts/restore-agents.ts --apply --session foreground --last-generation` via the injectable spawn seam; setup-tmux imports no ExecBackend.
- [ ] foreground-exists, zero-candidates, and non-TTY all skip without spawning.
- [ ] `bun run test:full` green.

## Done summary
setup-tmux offers a foreground last-generation restore when foreground is absent: TTY-only y/N prompt computed before any session-creating call, spawning restore-agents --apply --session foreground --last-generation via the injectable spawn seam (no ExecBackend import); candidate count reads keeper.db read-only via an injectable provider.
## Evidence
