## Overview

Turn panel runs into a durable, resumable state machine so an agent killed
mid-fan-out (quota/crash) re-attaches instead of re-running every leg. Today
`keeper agent panel start` mints a random `mkdtempSync(tmpdir(),"keeper-panel-")`
scratch dir held only in the starting agent's context; this replaces it with a
deterministic `~/.local/state/keeper/panels/<slug>/` dir keyed off the slug
fn-1041 already made required. `start` becomes idempotent-by-slug: on re-issue it
reconciles each leg — REUSE any terminal result (completed OR failed; resume is
not retry), LEAVE running legs alone, RELAUNCH only legs with no result yet.
Reboot is detected via a manifest-stamped `boot_epoch_ms` (os.uptime-derived,
generous tolerance) so pre-reboot pidfiles are never trusted. A per-slug advisory
lock (reused FileLock, flock/CLOEXEC) serializes concurrent drivers; a prompt +
member-set identity guard refuses a colliding-slug cross-run merge. New
introspection: `wait --slug`, read-only `panel status --slug`, and a `panel prune`
GC verb. Liveness is filesystem-only (result file + boot_epoch + pidfile) — never
keeper.db, and `src/pair/panel.ts` stays a dep-free leaf.

## Quick commands

- `keeper agent panel start /tmp/q.md --slug demo --cli codex` then re-run the SAME line — the second call reconciles (reuses/relaunches), does not re-fan-out
- `keeper agent panel status --slug demo` — per-leg completed/running/failed/absent, no blocking
- `keeper agent panel wait --slug demo` — block on the reconciled set by slug
- `keeper agent panel prune` — GC terminal, aged-out slug dirs
- `bun run lint && bun run typecheck && bun test` — green

## Acceptance

- [ ] Re-issuing `start --slug X` reconciles: terminal legs (completed or failed) reused, running legs left, no-result legs relaunched — never a blind re-fan-out
- [ ] Panel state lives at `~/.local/state/keeper/panels/<slug>/` (0700); a restarted agent rediscovers it from the slug alone
- [ ] Reboot (boot_epoch mismatch) forces every non-terminal leg to relaunch; a same-boot pidfile check governs otherwise
- [ ] A per-slug advisory lock serializes drivers; a prompt-or-member-set mismatch refuses the resume (exit 2)
- [ ] `wait --slug`, `panel status --slug`, `panel prune` work; prune never deletes a live or in-reconcile run
- [ ] `src/pair/panel.ts` stays dep-free (no bun:sqlite); `src/agent/main.ts` writeEnvelopeAtomic is untouched
- [ ] Docs consolidated (PANEL_HELP, dispatch synopsis, README panel + "ephemeral" line, panel-runner re-entry, pair, CLAUDE.md sole-writer); full suite green

## Early proof point

Task that proves the approach: `.1` — a deterministic slug-keyed dir + a
`boot_epoch_ms`-bearing manifest a restarted process can re-read. If it fails
(state-dir convention or the dep-free constraint won't hold), the whole resume
premise is wrong and later tasks pause. `.2` then proves reconcile end-to-end.

## References

- fn-1041 (done, on main) — provides the required `--slug`, `panel::<slug>::<preset>` leg names, and the manifest `slug` field this builds on
- src/agent/cwd-ordinal.ts — the flock-guarded state-dir JSON + fail-open one-time-migration precedent to mirror
- src/usage-flock.ts FileLock — the flock/CLOEXEC advisory-lock primitive to reuse (a detached leg never inherits the lock)
- src/statusline-worker.ts gcSweep + LEAF_TTL_MS — the age-based sweep template for prune
- src/usage-picker.ts:53 — keeper's deliberately-non-XDG ~/.local/state convention (keeperStateDir mirrors keeperConfigDir, not the XDG keeper-agent dir)

## Docs gaps

- **src/pair/panel.ts PANEL_HELP (~:847)**: add `status`/`prune`, `wait --slug`; rewrite `start` prose (deterministic dir, reconcile, identity guard exits 2, per-slug lock, boot-epoch); `--dir` is a location override, no longer "minted when absent"
- **src/agent/dispatch.ts USAGE (~:84) + KEEPER_AGENT_HELP (~:221 + prose ~:224-238)**: add `wait --slug`, `status`, `prune` synopsis + idempotent-by-slug prose
- **cli/agent.ts JSDoc (~:9)**: `panel start|wait|status|prune`, start idempotent by slug
- **README.md (~:1413-1481 + the "panels are ephemeral" line ~:32)**: consolidate — durable state under ~/.local/state/keeper/panels/, reconcile, the three new verbs; the no-DB/no-event claim stays true but "ephemeral" does not
- **plugins/plan/agents/panel-runner.md**: a Re-entry story — re-issue the same `start --slug` + same prompt reconciles; `wait --slug` is the simple re-entry form; the prompt path must survive re-entry / satisfy the identity guard
- **plugins/keeper/skills/pair/SKILL.md (~:63)**: `wait --slug` preferred re-entry, `status --slug`, `prune` housekeeping, idempotent-start note
- **CLAUDE.md Sole-writer rules**: one line — `keeper agent panel start` is the SOLE writer of `~/.local/state/keeper/panels/` (durable per-slug panel state; no daemon/hook touches it)
