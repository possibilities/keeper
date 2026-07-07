## Overview

Crash-restore of tmux-hosted agent tabs behaves like a browser's "restore tabs": after any tmux/server death the offer is exactly the just-lost generation, and every tab either verifiably re-attaches to its exact prior conversation or fails loudly — visible pane, durable per-tab artifact, one-command idempotent retry. Today's verified defects: claude resumes replay a drifted recorded cwd against project-dir-scoped `claude --resume`; the resume transport drops the KEEPER_JOB_ID identity contract so resumed pi tabs orphan and their recorded resume targets rot; generation auto-pick is richest-wins so a 2-day-old cohort beats the just-killed one while the consumer drops the documented ambiguous escalation; and failures vanish with their panes. Vocabulary is pinned in CONTEXT.md ("Crash restore" section: Generation, Restore, Harness resume, Resume target).

## Quick commands

- `cd ~/code/keeper && keeper tabs list | jq '.generations[:2]'` — newest dead generation must be the auto-pick candidate
- `keeper tabs restore` — dry-run; contested picks escalate, preflight failures name the fixing command
- `keeper tabs dump | head -40` — dumped resume lines must carry resolved cwds + identity env
- `bun test test/restore-set.test.ts test/tabs.test.ts test/restore-verify.test.ts test/restore-sim.test.ts`
- `KEEPER_RUN_SLOW=1 bun test test/restore-e2e.slow.test.ts` — real-tmux acceptance instrument

## Acceptance

- [ ] After a tmux server death, the setup-tmux offer names the just-killed generation (newest eligible dead), never an older richer one; a contested pick presents a numbered picker on a TTY and a visible refusal (naming the recovery command) non-TTY.
- [ ] A claude tab whose transcript rehomed to a different project dir restores from the transcript's holding dir; unresolvable tabs surface as preflight failures with the one fixing command, never doomed launches.
- [ ] A resumed non-claude tab folds onto its original keeper job id, and the next crash cycle emits its original harness-native resume target.
- [ ] A failed tab restore is never silent: visible diagnosed pane where tmux allows, durable artifact with the rerun command, resurfaces in `keeper tabs list` until verified; retries are idempotent (live-UUID no-op, single-flight, crash-loop bounded).
- [ ] `verified` is granted only on attach evidence (hook NDJSON for claude, birth record on the carried job id for non-claude) — never on window creation.
- [ ] A failed resume attempt can no longer overwrite `jobs.transcript_path` (activity-gated fold guard).
- [ ] Fast-tier sim and slow-tier real-tmux e2e are green.

## Early proof point

Task that proves the approach: `.2` (disk-anchored resolution — the keystone inversion from recorded state to on-disk truth). If it fails: fall back to slug-matching the observed cwd history alone (drop transcript-tail parsing), which still fixes the witnessed drift class.

## References

- CONTEXT.md "Crash restore" section — pinned vocabulary (Generation / Restore / Harness resume / Resume target).
- docs/adr/0007-positive-evidence-session-adoption.md — the fold guard refines its positive-evidence philosophy; adoption predicate untouched.
- Incident evidence (2026-07-07): generation `1826` (peak 31 panes, 2.1d old) out-offered just-killed `21705:1783191303`; sessions `51ee6f32-…` / `deba61ad-…` failed resume from recorded cwd (transcripts under `-Users-mike-code-keeper`); live pi job `45f94c4d-…` runs pi session `d98a2d54-…` under an orphaned identity (repair exemplar).
- `claude --resume` project-dir scoping reproduced: wrong cwd prints "No conversation found with session ID" and exits 0.

## Docs gaps

- **src/tabs-core.ts header**: consolidate SELECTION/RESULT prose to recency-first selection + disk-anchored resume + resume-target pinning.
- **src/restore-worker.ts header**: document the non-empty clobber guard.
- **cli/tabs.ts HELP/AGENT_HELP**: verified per-tab transactions, retry semantics, refined exit-8 meaning.
- **cli/setup-tmux.ts HELP**: escalate-or-refuse wording in lockstep with tabs-core.
- **docs/problem-codes.md**: Tabs family rows for exit 6 and 8.
- **src/restore-set.ts header**: conditional — only if generation keying changes shape.

## Best practices

- **remain-on-exit failed at pane creation:** window option, not retroactive; `pane_dead_status` is version-gated — probe capability, fall back to the wrapper.
- **Wrapper runs `"$SHELL"`, never `exec "$SHELL"`:** exec masks the real exit code and kills traps; capture `$?` on the next line; preserve signal deaths (128+n) in artifacts.
- **NDJSON evidence reads consume only complete lines:** buffer the trailing partial; never truncate a tailed file in place.
- **Locks: advisory flock on a local FS with identity {pid, start-ts, uuid}:** bare-PID liveness lies under macOS PID reuse; another live holder is an idempotent no-op, not an error.
- **Intent before effect:** fsync the per-tab attempt artifact before launch; the carried job identity is the idempotency key.
- **Crash-loop backoff:** browsers cap auto-restore attempts per tab — bound at 2 per generation, then on-demand only.
