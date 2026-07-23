# 100. Independent scoped Account focuses

## Status

Accepted. Supersedes ADR 0092 while preserving mandatory claude-swap execution, fresh eligibility evidence, stable PII-free Account routes, independent per-process selection, explicit-account precedence, and visible fallback to normal Account route selection.

## Context

A Fable focus lets an operator consume one account's Fable quota while steering non-Fable Claude work away from that account when another eligible route exists. Operators also need the complementary control: direct proven non-Fable Claude work to one account for a bounded window without changing Fable routing.

Treating the complementary control as another score would hide the requested route and make coexistence with Fable avoidance ambiguous. Replacing the Fable policy with one unscoped account target would prevent independent routes and lifetimes. The two traffic classes need explicit matching policies with deterministic precedence and isolated failure domains.

## Decision

Keeper supports two independent optional **Account focuses** over stable managed `claude-swap:<slot>` routes:

- **Fable focus** matches launches with proven Fable intent and retains permanent, absolute, current-reset, and cycle-end construction.
- **Non-Fable focus** matches launches with proven non-Fable intent and supports permanent or absolute UTC lifetime.

Unknown intent does not match either focus. Fresh launches and passthrough commands that Keeper can classify establish explicit intent; continuation, resume, restore, and fork inherit the process-lineage Fable intent when no explicit model choice overrides it. Launch attribution never supplies intent or Account affinity.

One eligible-route set is computed for each launch. Selection applies this precedence:

1. an explicit per-launch Account route;
2. the active eligible focus matching the launch's traffic class;
3. for non-Fable work with no applicable target, the active Fable target's existing soft avoidance while another eligible route exists; and
4. normal Account route scoring, reservation pressure, least-recently-used order, and stable tie-breaking.

A matching target wins while eligible regardless of reservation pressure. An absent, inactive, expired, unavailable, or ineligible matching target falls back visibly through the remaining precedence chain. Focus never makes an ineligible route viable, bypasses mandatory claude-swap routing, or turns missing global capacity evidence into success. An ambiguous failure after Claude process creation never risks a duplicate launch.

Each focus is one independently atomic durable config cell and one independently versioned, owner-only launch-delivery leaf. Each mutation round-trips through the generic config Synthetic event and Projection path; no focus-specific mutating RPC is added. Independent delivery ensures a malformed, unsupported, or unpublished Non-Fable policy cannot disable a valid Fable focus. A launcher may observe different generations because the policies are independent; each scope reports its own policy identity, effective state, eligibility, outcome, reason, and delivery diagnostic.

Absolute lifetimes are half-open and active only while `now < deadline`. Expiration is evaluated on routing and status reads, never inside a fold or by an in-memory timer. A guarded rollout activation verifies the target is present and eligible and the fixed deadline is still future before appending intent. A stale, absent, ineligible, elapsed, or concurrently changed target leaves existing policy unchanged; a missed rollout never starts a fresh relative window or clears a human's newer policy.

Account inspection and `keeper status` expose both focus views as additive PII-free machine fields. The board renders full-label peer sections named `Fable focus` and `Non-Fable focus` across live, snapshot, frame, sidecar, and copied output; an off focus collapses to one line, while configured or unavailable state shows target, lifetime, eligibility, effective routing state, and diagnostic without abbreviation or truncation.

## Alternatives considered

- **One unscoped focus target.** Rejected because Fable and non-Fable traffic need independent targets and lifetimes.
- **Make Non-Fable focus override Fable traffic too.** Rejected because matching scope is the predictable boundary; targeting both classes at one account is expressed by setting both focuses to that route.
- **Treat unknown lineage as non-Fable.** Rejected because a failed intent lookup could misroute Fable work; unknown follows normal selection.
- **Apply reciprocal Non-Fable-target avoidance to Fable traffic.** Rejected because no quota-conservation requirement justifies changing Fable routing when its own focus is absent.
- **Publish both focuses in one combined leaf.** Rejected because a Non-Fable delivery fault must not disable an already-valid Fable focus; the policies do not require cross-scope transactional updates.
- **Fail closed on an unavailable target.** Rejected because Account focus controls preference, not global Claude availability.
- **Begin a relative lifetime when code lands.** Rejected because rollout must honor the fixed request-time window and remain off after it passes.

## Consequences

- Setting both focuses to the same eligible Account route directs all proven Claude traffic classes there while their independent lifetimes overlap.
- A Non-Fable focus overrides Fable-target avoidance for matching non-Fable work, including when both targets are the same route.
- Fable traffic is neutral toward a Non-Fable target unless Fable focus or normal scoring selects it.
- Existing Fable policy storage, command behavior, and delivery remain compatible while the new sibling field and leaf are absent or invalid.
- Inspection, status, and board consumers gain a second focus view and must preserve desired/effective/delivery distinctions for each scope.
- The rollout can safely miss its deadline without mutating or erasing concurrent operator intent.
