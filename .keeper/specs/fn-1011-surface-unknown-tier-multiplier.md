## Overview

A `/login` re-auth restores the keychain (usage bars) but not the
`~/.claude/.claude.json` `oauthAccount` cache that holds the tier — so
`resolveMultiplier`'s boot `?? 1` silently renders a Max-20x account as a confident
`1x`. This epic propagates the raw nullable multiplier instead of collapsing it, so
an unresolved tier renders as `?x` ("tier unknown") in `keeper usage`, surfaces as a
`keeper agent profiles check` finding, and is documented in the re-home runbook.
Keeper-only; no schema/RPC/daemon change (the `usage.multiplier` column is already
nullable). Follow-up to fn-1010.

## Quick commands

- `keeper usage` — a subscription-active claude account with unresolvable tier shows `[claude ?x]` (not a false `1x`); a real tier still shows `[claude 20x]`.
- `keeper agent profiles check` — reports `~/.claude` authed-but-tier-missing as its own finding.
- `bun test test/usage.test.ts test/usage-scraper-worker.test.ts test/shadow-profiles.test.ts`

## Acceptance

- [ ] An unresolved tier renders `?x` for a subscription-active claude row; codex stays `[codex 1x]`; signed_out/no_subscription rows are not mislabeled and the broken `[claude  x]` is gone.
- [ ] The producer propagates a raw `null` multiplier (boot `?? 1` removed); `reResolveMultiplier` keep-prior stays intact (no transient downgrade of a good account).
- [ ] The picker weighting still treats null as 1 (already does — confirmed sole consumer); no schema/SCHEMA_VERSION change.
- [ ] `keeper agent profiles check` flags `~/.claude` authed-but-tier-missing as a distinct finding (db-free), with remediation pointing at the runbook.
- [ ] The re-home runbook documents the `oauthAccount`-metadata step; HELP/AGENTWRAP_HELP/README describe `?x` + the new finding.

## Early proof point

Task that proves the approach: `.1` (the `?x` surfacing end-to-end). If propagating null
breaks the change-detection/keep-prior or the chip layout, it surfaces here before the
detector work builds alongside.

## References

- Panel-informed direction (no panel this round; direction settled): keep raw `number | null`, apply the math fallback at the consumer, format `?x` at the display boundary — never collapse the nullability at parse time.
- KEEP-PRIOR subtlety (load-bearing): `reResolveMultiplier` (src/usage-scraper-worker.ts:308-326) deliberately keeps a prior multiplier on a transient re-read failure so a known account never downgrades; `null`/`?x` must surface ONLY for a boot-time never-resolved tier. Do not make a transient re-read render `?x` on a good account.
- Persistence already tolerates null: db.ts:898 `multiplier INTEGER` (no NOT NULL); reducer payload/extract/UPSERT handle null — no schema bump.
- The weighting consumer src/usage-picker.ts:276-283 already coerces null→1; it is the sole math consumer (grep-confirmed).
- Stale Python-parity comments ("mirrors the daemon's _resolve_multiplier_or_none") are descriptive only — no live .py multiplier code; no cross-repo work.

## Docs gaps

- **cli/usage.ts HELP (~:81-83)**: the chip renders `?x` when tier metadata is absent (not a `1x` default). (task .1)
- **README producer section (~:2954-2973)**: an absent tier → `?x` sentinel preserved in the envelope, not silent 1x. (task .1)
- **README `### Re-homing a stranded account` (~:3907-3930)**: `/login` restores only the keychain — also bring the `oauthAccount.organizationRateLimitTier` metadata; a persistent `?x` means that step is still pending. (task .2)
- **src/agent/dispatch.ts AGENTWRAP_HELP (~:112-117) + USAGE (~:53)**: widen the profiles-check finding enumeration to include tier-metadata-missing (keep the pair in sync). (task .2)
- **README profiles-check prose (~:1408-1412)**: add the tier-metadata-missing finding class. (task .2)

## Best practices

- **Don't `?? 1` at parse** — it collapses the union so downstream (incl. the renderer) can't tell synthetic from real; default at the math consumer instead. [practice-scout]
- **Named `formatMultiplier(raw): string`** at the display boundary (`null → ?x`), not inline `??`; hold the chip layout slot so `?x`/`1x`/`20x` don't jitter. [practice-scout]
- **`?x` = field-applies-but-missing** (correct here), distinct from N/A; never store the display string in the column (stays `INTEGER|NULL`). [practice-scout]
