# 92. Durable Fable focus routing

## Status

Accepted. Supersedes ADR 0079 while preserving mandatory claude-swap execution, fresh eligibility evidence, PII-free Account routes, independent per-process selection, and dynamic balancing as its fallback policy.

## Context

Keeper selects a managed claude-swap Account route for every Claude process. Dynamic Fable-aware balancing conserves or consumes quota across eligible accounts, but it cannot express an operator's short-lived goal to exhaust one account's Fable quota before its current reset while preserving that account's other quota for Fable work.

A hard account binding would reduce availability when the target is temporarily ineligible. Conversation affinity would also conflict with shared-history resume, where every process remains free to select from current capacity. The desired control is durable routing intent, not ownership of a conversation or account.

Fable launches may resume or restore without an explicit model argument, so launch-time command text alone cannot classify every process correctly. The control must remain inspectable across restarts and visible on the same semantic board surface in live, snapshot, frame, and copied output.

## Decision

Keeper supports one optional **Fable focus** over a stable PII-free Account route. The focus is generic to any managed `claude-swap:<slot>` route; an inventory ordinal is accepted only as an operator input resolved to that stable identity before persistence.

The focus participates in selection after normal eligibility is computed and before ordinary balancing scores are compared:

- an eligible Fable target wins;
- an ineligible Fable target falls back to normal eligible-route balancing and reports that fallback;
- non-Fable Claude work omits the target while another eligible route exists, but may use it as the sole eligible route; and
- an explicit per-launch account request remains the highest-precedence operator choice.

Fallback never bypasses mandatory claude-swap routing or makes an ineligible route viable. A target failure may select another route only when failure is positively known before Claude starts; ambiguous failure after process creation never risks a duplicate launch.

The focus has one tagged lifetime:

- `permanent` remains effective until explicitly replaced or cleared;
- `absolute` is effective while wall-clock time is strictly earlier than one timezone-bearing UTC deadline; and
- `cycle-end` completes on the first fresh target Fable observation proving full utilization or the snapshotted Fable reset boundary has completed.

A current-reset command is guarded construction of an `absolute` focus: it snapshots the fresh target `model:Fable` reset boundary and may require an expected boundary. A stale, missing, elapsed, or mismatched boundary leaves the prior policy unchanged and never rolls intent into a later cycle. Expiration is evaluated whenever routing or status reads the focus, not by an in-memory timer.

Fable intent is process-lineage routing metadata independent of Launch attribution. An explicit effective launch model establishes or overrides it; continuation, resume, restore, and fork inherit it when no explicit override exists. Clearly Fable legacy telemetry may seed it, while unknown legacy work uses normal balancing. Interactive model changes cannot move an already-running process.

Durable intent round-trips through Keeper's existing generic config Synthetic event and Projection path as one atomically validated policy update; no account-specific mutating RPC is added. The daemon publishes the effective PII-free policy to the account-routing launch boundary so a cold launcher does not import SQLite. Missing, corrupt, unsupported, or unreachable policy delivery degrades visibly to ordinary balancing rather than blocking Claude.

One canonical policy-status model supplies machine inspection, status, and the board's semantic header. The header allocates two or three width-aware lines, retains target, lifetime, and effective `focused`/`fallback` state at narrow widths, and appears in live, snapshot, frame, and copied diagnostic output without exposing credentials or account PII.

## Alternatives considered

- **Fail closed while a focus target is unavailable.** Rejected because the control exists to consume quota without halting work; visible fallback preserves availability without pretending the target was used.
- **Hard-bind a conversation to one account.** Rejected because Fable focus is process routing intent, while shared history keeps resume independent from prior Launch attribution.
- **Store focus only in the transient observation or reservation sidecars.** Rejected because those files are freshness-bounded routing evidence rather than durable operator intent.
- **Add an account-specific mutating RPC.** Rejected because Keeper's generic config event already carries future durable settings through the sole mutation boundary.
- **Recompute current reset after restart.** Rejected because silently advancing to a later cycle extends operator intent beyond the boundary that was approved.
- **Hide the focus in the live-only banner.** Rejected because snapshots, frame consumers, and copied diagnostics must report the same routing state a human sees.

## Consequences

- Dynamic Fable-aware balancing remains the complete behavior when no effective focus exists and the availability fallback whenever a target cannot serve a launch.
- Non-Fable avoidance is a soft preference, so one remaining eligible account can still serve all Claude work.
- Resume and restore gain routing-purpose metadata without creating account affinity.
- Policy mutation, inspection, status, and board rendering share one tagged lifetime and effective-state contract.
- A current-cycle activation can refuse safely without mutating policy, allowing an operator to distinguish a missed window from successful activation.
- The account-routing delivery boundary and board header become durable public contracts requiring schema, compatibility, narrow-width, and mixed-state tests.
