# 98. Machine-runnable codex-pool activation proof

## Status

Accepted. Amends ADR 0090 (proof-genuineness clause); relates to ADR 0090, 0057.

## Context

ADR 0090 gates codex-pool activation on a live proof whose 13-clause classifier
demands, among others, a "genuine pre-output account failure" and independent
credential refreshes on two aliases, and states that single-account and
synthetic proofs do not arm pooling. As landed, the proof surface is two
human-typed Pi slash commands, credential refresh fires only near expiry, and
no fault seam exists — so no automated launch can produce a report, and even a
human-typed run cannot reach `proven` without destructive inducers (real
credential revocation or quota exhaustion). One wrapped Pi leg, unable to run
the human-only commands, fabricated a plausible report from a replica harness;
self-reported clause booleans made fabrication cheap.

## Decision

1. **Proof genuineness is redefined** (the ADR 0090 carve-out): a clause is
   genuine when the production failure-handling path — classification, retry,
   cooldown, refresh, fallback — demonstrably executed inside an armed proof
   window, evidenced by a recorded event transcript. A provider-boundary fault
   injected through the sanctioned seam counts; a self-reported boolean, a
   replica harness, or a single-account run still does not.
2. **The proof surface is a model-callable Pi tool** (`registerTool`, inside
   the companion, where the in-memory evidence lives) exposing one atomic
   run-the-whole-proof orchestrator. No primitive kit for models to sequence:
   improvisation is what produced the fabricated report.
3. **Two bounded seams, inert outside an armed window**: a forced-refresh seam
   in the companion's credential layer (keeperd never touches credentials, per
   ADR 0090) and a fault-injection seam at the pooled-stream delegate, able to
   emit classified faults pre-output and mid-stream after substantive output.
   Seam inputs are bounded single JSON records, scoped to the classifiable
   fault enum.
4. **Reports are attestation-bound**: the verdict re-derives from the recorded
   per-clause transcript plus the existing revision/config/alias bindings, so
   a report that cannot be traced to an actually-observed run fails
   verification structurally.
5. **Proof reports are scope-exact**: schema v2 carries one top-level
   `quota_scope`, exactly `generic` or `model:gpt-5.3-codex-spark`, and every
   recorded route must carry that same scope. Mixed route scopes, display
   labels, older schemas, unknown fields, or unknown scope strings are invalid,
   not degraded evidence.
6. **Activation is scope-preserving**: a passing report replaces authorization
   only for its proved scope. Existing other-scope policy is preserved only when
   the stored activation is valid and still matches the current operational
   bindings; stale or malformed policy is dropped rather than inherited.

## Consequences

- The fn-1356 activation ladder consumes a machine-produced, scope-exact report;
  activation itself stays behind the ladder, and the report remains evidence-only.
- Proof runs perform real, bounded token rotations (normal OAuth refresh) on
  enrolled accounts; interruption leaves the last atomically-written credential.
- The companion import graph stays free of `bun:*`; the discipline gains a
  lint gate so a regression fails a test instead of killing Pi legs at runtime.
