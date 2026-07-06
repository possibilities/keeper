## Overview

Two verified hardening fixes survive the audit of the suite-baseline store.
First, the core contract module src/baseline-store.ts committed with a literal
NUL byte as a hash-input delimiter, which makes git classify the whole
697-line security-sensitive parser as binary — it ships unreviewable and
breaks grep/blame/editors. Second, the single-slot baseline runner's detached
subprocess wrapper only resolves on child close, so a killed-but-pipe-holding
process can permanently wedge the runner, violating the module's stated
never-wedge contract. Both are small, localized fixes; neither is fatal
(runtime behavior of the shipped feature is sound).

## Acceptance

- [ ] src/baseline-store.ts is plain text: git diffs it as text, grep/blame work, and the toolchain fingerprint hash is byte-identical to today.
- [ ] runDetached can never leave inFlight stuck: after a deadline kill the run promise force-resolves within a bounded grace even if child close never fires.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/baseline-store.ts:133 ships a literal NUL byte delimiter; git/file(1) treat the parser as binary, so it is unreviewable and breaks tooling. |
| F2 | kept | .2 | src/baseline-worker.ts:489 resolves only on child close; the deadline killGroup never force-resolves, permanently wedging the single-slot runner. |
| F3 | culled | — | Env inheritance at src/baseline-worker.ts:455 is latent-only — it needs a test that breaks the repo's enforced sandbox discipline, and stripping env fights the deliberate env-fidelity design. |

## Out of scope

- Baseline-subprocess env sandboxing (F3) — declined: latent behind enforced test discipline and in tension with the intended env-fidelity of the measured suite.
- Any change to the discriminated-union result contract or the reap-on-every-path invariants, which the audit found sound.
