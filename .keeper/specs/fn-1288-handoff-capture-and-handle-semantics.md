## Overview

Give `keeper handoff` an opt-in deliverable: a `--capture` flag makes the delegated worker's leg emit the standard 9-key agent-run answer envelope to a durable, discoverable path so fire-and-wait handoff composes with the existing chunked-wait machinery — while the default handoff (park at the confirm beat, no waiting) stays byte-identical. Alongside, align launch-handle SEMANTICS (dedup, resume-if-dead, message-if-live, per-surface scope) across pair names, handoff slugs, and panel run identity — docs, validation, and resolution behavior only; the three storage keys never merge.

## Quick commands

- `keeper handoff --help | grep -i capture` — the flag and its exit codes are documented
- `bun test test/handoff.test.ts test/handoff-worker.test.ts test/handoff-slug.test.ts` — handoff suites green
- `bun test test/agent-run-capture-golden.test.ts` — the shared envelope schema is unchanged

## Acceptance

- [ ] `keeper handoff --capture` requests a capturing handoff whose worker leg writes the standard 9-key envelope to a durable path recorded on the handoff row; without the flag, behavior is unchanged end-to-end
- [ ] Capture unlocks a launch-triple knob (model/effort/preset) validated at the CLI with a distinct exit code and re-validated at the RPC trust boundary; invalid combinations never mint an event
- [ ] A capturing handoff launches with an autonomous (non-parking) prompt framing; the default framing still parks
- [ ] The worker leg is the sole writer of the envelope; a waiter timeout detaches the waiter without writing a competing result
- [ ] Pre-feature handoff events fold cleanly to defaults; re-fold determinism holds
- [ ] Handle semantics (dedup, resume-if-dead, message-if-live, scope) are stated consistently across the pair/handoff/panel CLI contracts and skill runbooks; no storage key changes

## Early proof point

Task that proves the approach: ordinal 1 (the additive persistence thread). If the payload fields cannot fold safely to defaults, re-shape the columns before any CLI or worker work builds on them.

## References

- Design conclusion: handoff differs from pair by RESULT CONTRACT, not wait-vs-forget — capture is the deliverable contract as an opt-in flag, never a merged skill
- `fn-1287-single-source-agent-surface-contracts` (dependency): this epic's runbook prose cites the contracts doc it creates; the envelope field list is single-sourced there
- `fn-1282-retire-hermes-codex-harnesses` (dependency): rewrites src/agent/launch-handle.ts, run-capture.ts, resume-*, cli/agent.ts — this epic targets the post-retirement surface (`--cli <claude|pi>`)
- `fn-1285-reconcile-panel-cancellation-cleanup` (dependency, overlap): owns the src/pair/panel.ts request_id/cancellation/attempt-lifecycle struct surface this epic's handle-alignment prose touches
- Precedents: `KEEPER_WRAPPED_ENVELOPE` env-carrier (a detached leg already writes an envelope to an env-provided path); `target_dir` (the nullable additive request_handoff payload field template); `resolveDispatchLaunchConfig("handoff")` (handoff already pinnable per ADR 0040); `agent run --capture <path>` (the flag this one parallels)
- Sole-writer + timeout semantics per the async request-reply pattern: waiter polls a durable result, timeout detaches, cancellation/abort is explicitly out-of-scope this pass (worker stays recoverable); Temporal's reuse-vs-conflict policy split validates handle semantics as orthogonal flags

## Docs gaps

- **plugins/keeper/skills/handoff/SKILL.md**: runbook gains the capture fire-and-wait recipe (task 4 deliverable)
- **docs/problem-codes.md**: new machine-visible failure codes for invalid capture/triple combinations, if any are added
- **README.md (root)**: check the "Owned panels" bullet still reads accurately after handle-semantics prose lands

## Best practices

- **One authoritative writer for terminal result state:** worker envelope only; any daemon row is read-only bookkeeping [brandur idempotency]
- **Capture is never the silent default:** multi-agent capture flows cost ~15x a chat; the flag is explicit and the model knob stays available [Anthropic multi-agent]
- **Distinguish unknown-handle / running / done-but-empty on the read path** [Azure async request-reply]
- **Captured output is untrusted and attacker-influenceable:** one size-bounded record, no NDJSON/shell-injection surface
