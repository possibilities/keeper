# 47. Audit gate: self-read sizing, sink-persisted findings, advisory read guard

## Status

Accepted. Extends ADR 0014 (per-task audit gate rides the block machinery) — the gate
mechanics are unchanged, this restores the content-blind contract around them. Mirrors
ADR 0027's untrusted-return-to-trusted-verb precedent for the submit-task path.

## Context

Two content-blindness leaks had crept into the orchestrators. `/plan:close` computed the
close audit's depth band itself and carried it as a spawn argument, meaning the
orchestrator read plan signals that belonged to the auditor. `/plan:work`'s per-task audit
gate (ADR 0014) had no typed verb: the orchestrator relayed the auditor's raw finding
envelope and, on resume, read the persisted finding artifact directly to check idempotency
— both are prose-shaped reads a hostile or malformed finding could exploit to influence
orchestrator behavior. Nothing mechanically stopped a regression from reopening either
leak, or a new one, on the briefs/audits state trees generally.

## Decision

1. **Sizing signals are subagent-self-read.** The close skill passes the quality-auditor
   only `EPIC_ID` / `PRIMARY_REPO` / `BRIEF_REF` — pure envelope-and-paths coordination. The
   agent resolves its own `depth.band` from the brief it already opens, clamped
   `lean | standard | deep` with a lean floor, and echoes the resolved band in its report
   meta so the close-planner's vet-time comparison is unaffected.
2. **Findings persist sink-side**, never relayed by the orchestrator. Two verbs
   (`audit gate-check`, `audit submit-task`) share one commit-derivation helper so their
   hashes can never drift apart: `gate-check` is a read-only idempotency check that derives
   the task's current commit set itself and compares it against the persisted finding's
   stamped hash; `submit-task` persists the task-scoped auditor's findings payload with
   `commits` always server-derived, never caller-supplied. `/plan:work`'s Phase 2d switches
   on `gate-check`'s typed envelope and the auditor's one-line `finding_ref` return — it
   never opens the artifact.
3. **A fourth hook holds the line mechanically.** Once no legitimate orchestrator read of
   `.keeper/state/briefs` or `.keeper/state/audits` remains, a `PreToolUse` guard denies
   Read/Write/Edit/Bash access to those trees from a marked work/close session's main
   context (a subagent always passes). This is advisory context hygiene, not a security
   boundary — it fails open on every internal error and is bypassable with
   `KEEPER_PLAN_GUARD_BYPASS=1`; its documented gap is a Bash indirection the command-token
   scan never sees.

## Consequences

The orchestrator's coordination surface is now provably typed refs, hashes, counts, and
enums — no remaining code path in `/plan:work` or `/plan:close` opens a spec or a findings
artifact. The cost is one more hook dispatcher (fail-open, so no new hard-failure mode) and
a slightly deeper agent spec (the quality-auditor now owns two discriminant-selected
modes). No new reconcile verdict or RPC; the gate mechanics ADR 0014 established are
unchanged.
