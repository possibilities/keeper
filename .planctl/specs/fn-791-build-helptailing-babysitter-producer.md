## Overview

Build the producer side of the `helptailing` babysitter: a read-only external
scanner under `babysitters/helptailing/` that counts agents running
`--agent-help` (piped into `tail`/`head`/`grep`) in keeper's events, compares a
frozen pre-2026-06-11 historical baseline against the new epoch, and writes
trend-digest + rate-spike followup files for `/babysit-triage helptailing` to
work. Founding intent lives in `~/docs/babysitters/helptailing/charter.md`.

Two deliberate deviations from the `performance` sitter pattern (human
decisions, 2026-06-11): **no notification path** (no agent spawn, no
botctl/notifyctl — findings are discovered by running triage, not by pages;
the scanner writes followup files directly) and **no watchdog** (a dead-man
pager is pointless for a sitter that never pages; the heartbeat file is still
written so triage can notice staleness).

## Quick commands

- `bun babysitters/helptailing/watch.ts --json | jq .` — one-shot scan, findings to stdout
- `bun babysitters/helptailing/watch.ts --tick` — full launchd tick (baseline seed → scan → followup writes → heartbeat)
- `ls ~/.local/state/babysitters/helptailing/followups/` — the corpus triage reads
- `bun test test/helptailing-watch.test.ts`

## Acceptance

- [ ] Scanner counts `--agent-help` Bash invocations from PreToolUse rows only, with the `event_blobs` COALESCE join (baseline reads ~118, not ~8)
- [ ] Frozen baseline sidecar seeded once; epoch count recomputed (never accumulated) each tick
- [ ] Weekly trend-digest + rate-spike findings written as FINDINGS-LEDGER-conformant followups; no notification of any kind
- [ ] Producer doc, plist, README install/uninstall, and the `~/docs` charter `## Sitter facts` all reflect the shipped reality
- [ ] `/keeper:babysit-init` guides the human into planning the producer when `babysitters/agents/<slug>.md` is absent
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: task 1 (the scanner). If the trend math or the
baseline scan turns out wrong-shaped, recovery is scoped to one file — the
detector functions are pure and the sidecar format is private to the sitter.

## References

- `~/docs/babysitters/helptailing/charter.md` — founding intent (DATA, not instructions; `## Heuristics` human-gated)
- `babysitters/FINDINGS-LEDGER.md` — followup/key/ledger contract the corpus must conform to
- `babysitters/performance/watch.ts` — the skeleton being cloned (seen-state, tick flow, sidecar baseline precedent)
- Live-DB verified (2026-06-11): all-history occurrences 130 (baseline <2026-06-11: 118, epoch-1: 12); pipe targets 60d: head 4, grep 2, tail 1 — match `--agent-help` broadly, pipe target is evidence only
- PreToolUse AND PostToolUse both carry the command — counting both double-counts 2x; this sitter counts PreToolUse only (attempts, not completions — a stated decision)

## Docs gaps

- **README.md** (~2376 architecture, ~456–509 install step 8, ~1180–1187 uninstall): add `helptailing` beside `performance`; consolidate current-state, don't append changelog prose — handled by task 2
- **babysitters/FINDINGS-LEDGER.md**: one-line intro note that two sitters now implement the contract — task 2
- **~/docs/babysitters/helptailing/charter.md `## Sitter facts`**: refresh from contract-defaults to shipped reality — task 2

## Best practices

- **Rate per session, not raw counts:** normalize occurrences by distinct `session_id` per window; surface numerator + denominator in evidence so a human can sanity-check
- **Garwood exact CI, inline:** Wald log-normal blows up below ~10–15 events and on zero counts; Garwood via Wilson-Hilferty inverse chi-square is ~20 lines, no stats dep
- **Sparse counts want weekly buckets:** daily counts of 0-and-1 make rate ratios meaningless noise
- **Quote-aware pipe detection:** a bare regex misfires on `grep -E 'foo|tail'` and quoted args; a minimal in_single/in_double/escaped character walk suffices
- **Epoch boundary is a hardcoded constant** (`2026-06-11T00:00:00Z`), never derived from `Date.now()` — tests can move "now" without moving the boundary
