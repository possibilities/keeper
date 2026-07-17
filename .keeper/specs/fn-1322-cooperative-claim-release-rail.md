## Overview

A blocked commit-work peer facing a live foreign Exclusive file claim
gains a cooperative third out (today: wait or kill). Per ADR 0078
(committed at plan time): a claimant-side verb voluntarily releases named
paths via a durable, identity-proven, claimant-sole-written release
record the classifier reads as a voluntary terminal-witness (a live
sibling of the vacated-claim gone-witness — read-side only, no RPC, no
schema step); release self-fences the releasing session; the refusal
envelope gains a typed request-release pointer; the notice is an
advisory best-effort bus send; grace-timeout escalation rides the
existing block-escalation ladder. Auto-forfeiture and non-consensual
fencing are explicitly deferred.

## Quick commands

- `bun test ./test/commit-work.test.ts` — the refusal-envelope + classifier suites
- `keeper session release --help` — the new claimant-side verb (name per implementation)

## Acceptance

- [ ] A live claimant can voluntarily release named paths without dying; those paths become adoptable by the blocked peer while unreleased paths stay protected
- [ ] The releasing session's own subsequent commit-work no longer treats released paths as its own (self-fence)
- [ ] Every ownership-conflict refusal carries the typed request-release pointer with claimant identity and contended paths; declines are durable and honored with backoff
- [ ] Agent-facing guidance routes contention to the rail and states never-signal-a-live-peer; golden fixtures regenerate in the same change

## Early proof point

Task that proves the approach: ordinal 1 (the release record + classifier
read + self-fence). If per-path layering over session-granular
classification proves unsound: fall back to whole-claim release only
(all-or-nothing), still voluntary and self-fenced.

## References

- docs/adr/0078-cooperative-claim-release.md — the contract (extends 0063/0068; the read-side-only stance holds)
- Design pins from plan-time analysis: authority = the claimant's record (requester-side pending state is self-discipline only, never outcome authority); notice delivery is never load-bearing (inbox-less claimants cannot deadlock the requester); grace escalation = re-run commit-work after grace → BLOCKED with request evidence → the existing ladder pages; DECLINE is terminal per request with attempt-budgeted backoff
- The FOUR ownership_conflict emit sites must all carry the pointer (initial surface, post-lint, before-publication, generic) — reason fields already discriminate
- "Release" vocabulary: distinct from the wrapper-attempt lease release AND from Vacated claim (process-gone); the glossary gains two terms beside them, prune-first at the cap
- NON-GOALS: auto-forfeiture, fencing a non-consenting holder, any RPC widening, any daemon.ts change
- OPERATOR NOTE: the worker-partial edits trip the fingerprint wedge at landing — recompile host manifests (`keeper prompt compile --role work:worker --target claude`) after this epic lands

## Docs gaps

- **docs/problem-codes.md**: revise the ownership_conflict row + consolidate the never-signal stance with the signal-safety family — owned by ordinal 3
- **commit-via-keeper-default snippet + _index.yaml + prompt-oracle fixtures**: request-release path + policy line, fixtures regenerated together — owned by ordinal 3
- **worker-implement-native/wrapped partials**: route contention to the rail — owned by ordinal 3
- **CONTEXT.md**: two new terms (voluntary release record, request-release notice) beside Vacated claim, prune-first — owned by ordinal 3

## Best practices

- **Authority lives with the holder's durable record, never the requester's inference** — a merely-slow holder must not split-brain an impatient one [DLM/idempotency literature]
- **Partial release only at phase boundaries; decline-by-default on ambiguity** — a holder never releases a path its in-flight work depends on [2PL discipline]
- **Timeout is a suspicion signal that arms escalation, never an abort mechanism** — expiry pages a human; it never touches the peer [PostgreSQL deadlock posture]
