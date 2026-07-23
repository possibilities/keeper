# 109. Statusline-named launch account selection

## Status

Accepted. Extends ADR 0090, ADR 0100, ADR 0103, and ADR 0105.

## Context

Claude and Pi statuslines present launch accounts as one-based, Harness-qualified labels: `claude-N` for the current Claude inventory order and `codex-N` for Pi's configured Codex alias order. Claude's existing explicit selector instead uses zero-based `cN`, while the retained `--x-profile` spelling carries no account-selection behavior.

The display labels are useful launch-local vocabulary but are not stable identity. Claude selection must still resolve one exact eligible Account route through current claude-swap evidence. Pi selection must still respect model-scoped capability, pressure, and activation policy while preserving the provider boundary's pre-Substantive-output failover. Treating the Pi label as a hard pin, or treating either label as affinity, would conflict with those routing contracts.

## Decision

`--x-profile` is the Harness-aware Account selector over the statusline label vocabulary:

- Claude accepts canonical `claude-N`; Pi accepts canonical `codex-N`; `N` is a one-based ASCII decimal integer with no leading zero.
- A selector whose prefix does not match the active Harness, whose syntax is malformed, or whose requested account cannot be selected fails explicitly before the Claude or Pi Harness process starts.
- Repeated `--x-profile` occurrences use the final occurrence. Any invocation containing both `--x-profile` and `--x-account` is rejected rather than applying precedence.
- `--x-account` remains Claude-only and zero-based for compatibility.

For Claude, `claude-N` maps to current inventory ordinal `N - 1` and uses the existing exact explicit-route path. Freshness, eligibility, reservation, and no-substitution behavior remain authoritative.

For Pi, `codex-N` indexes the full configured alias order used by the statusline, without compacting around ineligible aliases. The selected alias must be authorized and eligible for the startup model's quota scope, and its launch reservation uses the normal pressure path constrained to that alias. The complete activated alias policy still reaches the companion: the selector supplies the initial one-shot seed, while existing bounded pre-output failover, generic native fallback, Spark fail-closed behavior, and independent child selection remain intact.

Account display labels are invocation-relative selectors, never stable Account route identifiers, persisted defaults, Account focuses, or conversation affinity. The `--x-profile` spelling does not authorize profile directories, copied credentials, or Harness state farms.

## Alternatives considered

- **Expose only stable route or opaque alias identifiers.** Rejected because those identifiers are diagnostic and policy boundaries, while the operator already sees the positional labels on each Harness statusline.
- **Make `codex-N` a hard runtime pin.** Rejected because it would disable the established pre-output failover and independent child-selection safety contract.
- **Silently fall back when an explicit selector is unavailable.** Rejected because explicit account intent must not run under an unintended identity.
- **Replace `--x-account` immediately.** Rejected because retaining its existing behavior keeps current launch scripts compatible while the statusline-named interface becomes available.
- **Restore profile farms behind `--x-profile`.** Rejected because account routing and credential ownership belong to claude-swap and the Pi Codex companion rather than Keeper-created config directories.

## Consequences

Operators can copy the account label they see on a Harness statusline into a launch command. Claude and Pi share one selector spelling while retaining their distinct routing truth boundaries: exact Claude process routing and failover-capable Pi launch seeding. Positional labels can refer to different underlying accounts when current ordering changes, so durable policy and diagnostics continue to use stable routes or opaque aliases. Existing profile-farm prohibitions, credential boundaries, runtime retry limits, and proven-route diagnostics remain unchanged.
