## Overview

`keeper usage` currently hides a no-subscription profile entirely and lets a
logged-out profile mislabel as a slow `panel_missing` timeout. This epic makes
the TUI tell apart three distinct "no quota bars" states — **signed out**,
**no active subscription**, and **unexpected scrape error** — via a new
orthogonal `account_state` axis threaded from agentusage's scrape classification
through keeper's contract → worker → fold → schema → renderer. End state: every
tracked profile is visible, each no-bar row carries a one-line reason, and a
logged-out account is detected fast and safely (no OAuth paste-field poisoning).

Scope is ONLY the 3-state surfacing. The auth-landed-in-the-wrong-dir root-cause
fix and the operator's manual re-auth witness are separate follow-up planks.

## Quick commands

- `keeper usage --snapshot` — the `(default)` row renders `no active subscription`
  (or `auth · signed out`) instead of vanishing; healthy rows' bars stay aligned.
- `bun test test/usage.test.ts test/usage-worker.test.ts test/schema-version.test.ts`
- agentusage: `uv run python -m pytest` (sign-in classification fixtures)

## Acceptance

- [ ] The three no-bar states render distinctly: `auth · signed out`,
  `no active subscription`, and the existing scrape-error line.
- [ ] No-subscription rows are no longer hidden; healthy rows' bar columns stay aligned.
- [ ] A logged-out profile is classified `signed_out` pre-send (no timeout, no `/usage`
  typed into the OAuth paste field) and emits the additive `ok`+`signed_out:true` arm.
- [ ] `usage.account_state` column lands via forward migration v96→v97 with the
  `SUPPORTED_SCHEMA_VERSIONS` dual-bump; re-fold is deterministic (malformed/pre-v97 → NULL).
- [ ] The usage-picker rotation is unaffected (signed_out→null and no_subscription→false
  both stay excluded; null is the load-bearing encoding here).
- [ ] Operator-facing docs (cli/usage.ts HELP header, README usage subsection +
  schema history) describe the new states accurately; no stale "do not render" prose.

## Early proof point

Task that proves the approach: `.1` (agentusage signed-out classification). It is the
genuinely novel/uncertain piece — reliable pre-send detection of the sign-in screen
against a real logged-out render. If it fails (sentinels can't be pinned reliably):
fall back to classifying signed-out as a distinct `error_kind` via the existing
parse-error path — label-only, accepting today's slowness — and keep the keeper axis.

## References

- Panel-vetted design (Opus 4.8 + GPT-5.5 converged): a dedicated orthogonal
  `account_state` axis, NOT an `error_kind` overload. Four facts stay separate —
  freshness (`status`), picker eligibility (`subscription_active`), scrape-failure
  class (`error_kind`, rides only on `status="stale"`), stable account state (`account_state`).
- `error_kind` (schema v95) is the end-to-end precedent to mirror: stable string set +
  `asUsageErrorKind`-style coerce-to-null validator threaded contract → ScrapeResult →
  envelope → message → gate → reducer → column → renderer.
- Contract note: `account_state` is keeper-derived and written to the agentusage on-disk
  ENVELOPE; it is NOT a new field on the scrape_cli JSON wire contract, so
  `SCRAPE_CONTRACT_SCHEMA_VERSION` (=1 both sides) does NOT bump. The only new contract
  surface is the additive optional `signed_out:true` on the existing `ok` arm.
- Deploy order: land/deploy keeper (account_state parse) before agentusage starts emitting
  the new arm — a pre-patch keeper reading `ok`+`signed_out:true` degrades that one account
  to `runner_failure` (`src/usage-scrape-runner.ts:282`) until keeper ships.
- Background: the `default` profile (`~/.claude`) is the case that exposed this — its
  keychain slot scrapes as no-subscription while the real Max 20x account is stranded in
  `~/.claude-profiles/default/` (the separate follow-up plank).

## Docs gaps

- **cli/usage.ts JSDoc/HELP header (~75-103, gating comment 316-320)**: revise the
  "Untracked profiles … do not render" sentence and the `subscription_active` gating
  prose to describe the three `account_state` render states. (task .3)
- **README.md usage.ts subsection (~1282-1332)**: revise the filter prose, add the
  `account_state` column to the field list, fold in the three render states. (task .3)
- **README.md schema-history block (~1936)**: add the v96→v97 entry (account_state TEXT
  APPEND-via-ALTER; `SUPPORTED_SCHEMA_VERSIONS` gains 97, whitelist-only). (task .2)
- **README.md usage projection schema comment (~3800)**: name the `account_state` column. (task .3)

## Best practices

- **Multi-sentinel quorum, not a single needle:** terminal wrapping/locale/mid-frame
  renders split any one string; require a 2-of-3 fingerprint over the joined
  `screen.display`, gated on alt-screen-active. [practice-scout]
- **Classify pre-send:** detection must precede `send_slash_command` — `ctrl+u` does not
  protect the OAuth paste field; only classification-before-send does. [practice-scout]
- **Size the pyte Screen from the PTY spawn dimensions** or long lines wrap mid-token and
  split sentinels; join adjacent display lines before matching. [practice-scout]
- **Trust only the post-pyte `screen.display` for state decisions, never raw `child.before`** —
  adversarial ANSI cursor-jumps can spoof a state transition (Trail of Bits 2025). [practice-scout]
