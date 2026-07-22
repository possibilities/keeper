# 105. Capability-scoped Codex routing

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Amends ADR 0090 and ADR 0098 for model-scoped provider capability.

## Context

Enrolled Codex accounts do not necessarily expose the same models. In particular, the provider can expose the `GPT-5.3-Codex-Spark` quota meter on one account and omit it on another while both accounts remain healthy for generic Codex. Treating every enrolled credential as Spark-capable makes proof demand impossible cross-account behavior and can send native fallback traffic to an account that the provider rejects for that model. Routing by account-category labels would encode product assumptions rather than provider evidence.

Capability and current eligibility are different facts. A Spark-capable account can be exhausted or cooling down, while a healthy generic account with no Spark meter does not support Spark at all. Enrollment and bindings still cover every credential because unsupported Spark accounts remain useful for generic traffic.

## Decision

The sanitized provider observation is the capability authority. Generic Codex is supported by every enrolled alias. The exact `model:gpt-5.3-codex-spark` scope is supported only when an alias's fresh validated windows contain that scope. Account category is display-only.

Proof reports use strict schema v3 and attest `scope_supported` for every bound alias. Reports are invalid when a route names an alias unsupported for the proved scope. A proof with one supported Spark alias is fully proven when all routes stay on that alias; its retry clause attests the classified-failure and attempt bound because no alternate route exists. With two or more supported aliases, proof also requires a genuine two-attempt failover and distinct root and child routing. Credential refresh still covers enrolled aliases. Capability absence is not quota degradation.

Proof launch policy and activation policy use the attested capability subset in enrolled-alias order. Mixed activation can therefore authorize generic `[a,b]` and Spark `[b]` without a degraded marker. Runtime observations may remove an authorized alias from eligibility immediately; newly observed capability requires a fresh proof before policy broadens.

Generic pool failure retains visible native fallback. Managed Spark traffic never invokes native fallback outside its proven capability subset: no supported or eligible Spark route produces a visible bounded error instead.

## Consequences

- Product-tier names never become authorization policy.
- Unsupported aliases remain enrolled, refreshed, and available to generic Codex.
- Spark works with the capable subset and cannot leak to a generic-only account.
- Activation verification rejects authorized aliases that current observations no longer support.
- Zero-capability Spark proof fails closed; capability growth requires deliberate re-proof and activation.
- Proof schema v2 reports remain evidence-only historical artifacts and cannot activate the new contract.
