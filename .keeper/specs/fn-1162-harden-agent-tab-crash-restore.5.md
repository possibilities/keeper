## Description

**Size:** M
**Files:** src/restore-verify.ts, src/tabs-core.ts, cli/tabs.ts, src/agent/main.ts, test/restore-verify.test.ts, test/tabs.test.ts, test/agent-byte-pin.test.ts

### Approach

Restore becomes a per-tab verified transaction. A durable intent artifact (state dir, 0600, schema-versioned, fsynced) is written BEFORE each launch — generation id, job id, harness, native target, resolved cwd, argv, exact rerun command, attempt count, state, reason — and cleared only on verified. States: planned → preflight_failed | launched → verified | failed | launched-unverified. Verification reads on-disk evidence, daemon-down-safe (new `src/restore-verify.ts`): claude attach = a SessionStart for the exact requested session id observed in the per-pid events-log NDJSON (complete-line reads via the existing parse helpers; env-overridable dir); non-claude = the birth-record file carrying the carried job id plus a live pane. Bounded wait (~20s, injected clock/retry seam), then disambiguate by pane liveness: pane dead ⇒ failed (capture pane_dead_status where the tmux version supports it), pane alive without evidence ⇒ launched-unverified warn — never a false verified, and launch exit codes alone never grant verified. Visible failure: the pane launch script wraps the harness — on non-zero exit it prints the diagnosis and exact rerun command, then drops to `"$SHELL"` (no exec; `$?` captured immediately; 128+n preserved into the artifact); `remain-on-exit failed` set at creation where supported (probe, ignore-errors fallback). Retry surface: failed/preflight_failed tabs resurface in `keeper tabs list` and a retry path in `keeper tabs restore` re-derives resolution from scratch, no-ops when the session UUID is already live, honors the crash-loop bound (2 auto-attempts per tab per generation, then on-demand only), and holds a per-apply advisory flock on a local state file (identity-carrying: pid + start-ts + uuid; a concurrent live holder is an idempotent success). Per-tab outcome lines report verified/failed/unverified; partial failure keeps exit 8 with refined meaning.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/tabs-core.ts:141-225 — applyRestore + outcome shapes to extend with the new states
- src/exec-backend.ts:1213-1276 — keeperAgentLaunch's window-created verdict (what verified must NOT trust)
- src/dead-letter.ts:224-277 — EventLogRecord parse + torn-tail contract; src/db.ts:651-662 — events-log dir resolver
- src/birth-record.ts:38-90 — birth-record shape + maildir layout for the non-claude evidence read
- src/agent/main.ts — locate the tmux launch-script composition (the runDir launch.sh writer) for the failure wrapper + remain-on-exit hook

**Optional** (reference as needed):
- cli/setup-tmux.ts:723-845 — RestoreRetryStore schema/atomic-write precedent to generalize per-tab
- cli/tabs.ts:77-95, 518-694 — exit codes + runRestore/runApply flow
- test/helpers/retry-until.ts — the poll helper (never Bun.sleep in tests)

### Risks

- Hook-evidence absence (hooks disabled, ingest irrelevant) must degrade to launched-unverified, not failed — pane liveness is the disambiguator.
- The wrapper changes the pane creation command — respawn semantics and byte-pinned launch scripts may shift; update pins in the same change.
- Artifact GC: generation-scoped, cleared on verified, swept past the 7-day idle cutoff — stale intents from prior generations must never re-offer.

### Test notes

Fake evidence dirs: NDJSON with the right/wrong session id, torn tail; birth-record present/absent; pane-liveness fake. Assert the full state matrix incl. timeout paths. Flock: second concurrent apply is a no-op success. Crash-loop: third auto-attempt refused with an on-demand hint.

## Acceptance

- [ ] A restore whose window is created but whose resume dies reports that tab failed — visible diagnosed pane where tmux allows, durable artifact with the rerun command, and the tab resurfaces in keeper tabs list until verified.
- [ ] verified is granted only on attach evidence (claude: hook NDJSON for the exact session id; non-claude: birth record on the carried job id); evidence-absent-with-live-pane reports launched-unverified, never verified or failed.
- [ ] Retries are idempotent: an already-live session UUID no-ops, concurrent applies cannot double-spawn, and the third auto-attempt in one generation is refused with an on-demand hint.

## Done summary

## Evidence
