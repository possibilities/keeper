## Overview

The codex-pool activation gate demands a live proof no machine can currently
produce: the proof surface is human-typed slash commands, credential refresh
only fires near expiry, and no fault seam exists — so the 13-clause gate is
structurally unsatisfiable and the activation ladder (fn-1356) is dammed.
This epic lands a model-callable atomic proof orchestrator inside the Pi
companion, two bounded window-gated seams (forced-refresh, fault-injection),
attestation-bound reports whose verdicts re-derive from recorded evidence,
a lint gate keeping the companion import graph bun-free, and the docs
rewrite. Decisions are recorded in ADR 0098 (amending 0090's genuineness
clause).

## Quick commands

- `bun run test:pi-codex-pool` — companion suites (seams, orchestrator, sanitation)
- `bun scripts/lint-source.ts` — includes the pi-extension bun-free graph gate
- `keeper agent run pi --model openai-codex/gpt-5.4-mini "Call the codex-pool proof tool and report its verdict"` — end-to-end machine proof probe (armed window)

## Acceptance

- [ ] A managed pi launch can produce a genuine `proven` report with no human-typed commands
- [ ] Both seams are inert outside an armed proof window and scoped to classifiable inputs
- [ ] A report not derived from an actually-recorded run fails verification
- [ ] The companion import graph is lint-enforced bun-free
- [ ] Docs describe only the machine-runnable path (walkthrough rewritten, not appended)

## Early proof point

Task that proves the approach: ordinal 1 (the seams). If forcing a real
refresh or emitting a classified mid-stream fault proves infeasible inside
the companion, recovery: re-scope the orchestrator to the clauses the seams
can drive and route the remainder through a redesign spike before task 2.

## References

- docs/adr/0098-machine-runnable-codex-pool-proof.md — the governing decisions
- docs/adr/0090-keeper-managed-pi-codex-account-pool.md — amended genuineness clause, credential boundary
- `fn-1356-activate-pi-codex-account-pool` (reverse-dep) — activation consumes this epic's proof surface; its acceptance needs the forced-refresh and fault seams
- plugins/keeper/pi-extension/task-facade.ts — the in-repo registerTool precedent
- integrations/pi-codex-pool/src/proof.ts + src/codex-pool-proof-window.ts — reuse, never duplicate

## Docs gaps

- **docs/install.md**: rewrite the proof-window walkthrough to the machine path; delete the slash-command steps
- **integrations/pi-codex-pool/README.md**: live-proof section describes the tool + seams
- **docs/problem-codes.md**: revise Pi Codex pool rows if verdict production changes; document any new failure class
- **CONTEXT.md**: glossary entries for the two seams and the seam-vs-synthetic genuineness distinction

## Best practices

- **Injectable credential/clock seams:** the proof never reads real auth.json outside the companion's own vault path; synthetic inputs are loudly marked
- **Single-refresh-owner:** concurrent routed requests must provoke exactly one refresh per alias — the top real-world OAuth-pool bug
- **Terminal vs retryable, both proven:** invalid_grant-class faults must not retry; 429/5xx-class must back off honoring Retry-After
- **Bound everything:** retries, total run budget inside the proof window, backoff caps, refresh-lock watchdog; no wall-clock reliance in verdict derivation
- **Gated seams:** an always-on fault seam is an attack surface; window + job-id gating, bounded one-record JSON inputs
