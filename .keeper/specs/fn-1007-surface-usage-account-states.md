## Overview

`keeper usage` currently hides a no-subscription profile entirely and lets a
logged-out profile mislabel as a slow scrape error. This epic makes the TUI tell
apart three distinct "no quota bars" states — **signed out**, **no active
subscription**, and **unexpected scrape error** — via a new orthogonal
`account_state` axis threaded from the scrape contract through keeper's worker →
fold → schema → renderer. End state: every tracked profile is visible and each
no-bar row carries a one-line reason. (The producer half — agentusage's
`signed_out` classification — is the sibling epic.)

Scope is ONLY the keeper-side surfacing. The auth-landed-in-the-wrong-dir
root-cause fix and the operator's manual re-auth witness are separate follow-up planks.

## Quick commands

- `keeper usage --snapshot` — the `(default)` row renders `no active subscription`
  (or `auth · signed out`) instead of vanishing; healthy rows' bars stay aligned.
- `bun test test/usage.test.ts test/usage-worker.test.ts test/schema-version.test.ts`

## Acceptance

- [ ] The three no-bar states render distinctly: `auth · signed out`,
  `no active subscription`, and the existing scrape-error line.
- [ ] No-subscription rows are no longer hidden; healthy rows' bar columns stay aligned.
- [ ] `usage.account_state` lands via forward migration v96→v97 with the
  `SUPPORTED_SCHEMA_VERSIONS` dual-bump; re-fold is deterministic (malformed/pre-v97 → NULL).
- [ ] keeper parses the additive `ok`+`signed_out:true` arm (so a logged-out profile folds to
  `account_state="signed_out"`); `SCRAPE_CONTRACT_SCHEMA_VERSION` is unchanged.
- [ ] The usage-picker rotation is unaffected (signed_out→null and no_subscription→false stay excluded).
- [ ] Operator-facing docs (cli/usage.ts HELP header, README usage subsection + schema history)
  describe the new states; no stale "do not render" prose.

## Early proof point

Task that proves the approach: `.1` (thread `account_state` end-to-end). If the orthogonal-axis
model doesn't fold cleanly (re-fold determinism or the UPSERT 4-spot), that surfaces here before
the renderer is built on top of it.

## References

- Panel-vetted design: a dedicated orthogonal `account_state` axis, NOT an `error_kind` overload.
  Four facts stay separate — freshness (`status`), picker eligibility (`subscription_active`),
  scrape-failure class (`error_kind`, rides only on `status="stale"`), stable account state.
- `error_kind` (schema v95) is the end-to-end precedent to mirror: stable string set +
  `asUsageErrorKind`-style coerce-to-null validator threaded contract → ScrapeResult → envelope →
  message → gate → reducer → column → renderer.
- `account_state` is keeper-derived and written to the agentusage on-disk ENVELOPE; it is NOT a
  new field on the scrape_cli JSON wire contract, so `SCRAPE_CONTRACT_SCHEMA_VERSION` (=1) and
  `ENVELOPE_SCHEMA_VERSION` (=1) do NOT bump.
- Sibling producer epic (agentusage): "Classify signed-out scrape in agentusage" emits the
  `signed_out:true` arm. Deploy order: land/deploy THIS keeper epic (which parses the new arm)
  before the agentusage emitter — a pre-patch keeper reading `ok`+`signed_out:true` degrades that
  account to `runner_failure` (`src/usage-scrape-runner.ts:282`) until keeper ships.
- Background: the `default` profile (`~/.claude`) is the case that exposed this — its keychain
  slot scrapes as no-subscription while the real Max 20x account is stranded in
  `~/.claude-profiles/default/` (the separate follow-up root-cause plank).

## Docs gaps

- **cli/usage.ts JSDoc/HELP header (~75-103, gating comment 316-320)**: revise the
  "Untracked profiles … do not render" sentence and the `subscription_active` gating prose to
  describe the three `account_state` render states. (task .2)
- **README.md usage.ts subsection (~1282-1332)**: revise the filter prose, add the `account_state`
  column to the field list, fold in the three render states. (task .2)
- **README.md schema-history block (~1936)**: add the v96→v97 entry (account_state TEXT
  APPEND-via-ALTER; `SUPPORTED_SCHEMA_VERSIONS` gains 97, whitelist-only). (task .1)
- **README.md usage projection schema comment (~3800)**: name the `account_state` column. (task .2)

## Best practices

- **Mirror `error_kind` exactly** — clone the `asUsageErrorKind`/`USAGE_ERROR_KINDS` shape for
  `AccountState`; do not invent a new validation idiom.
- **UPSERT placeholder discipline:** the usage UPSERT is hand-maintained in 4 spots; update all
  four together or a column shifts silently.
- **Re-fold determinism:** `asAccountState` coerces garbage → NULL and never throws; NULL is the
  zero-event default (no column DEFAULT); a pre-v97 event re-folds byte-identically.
