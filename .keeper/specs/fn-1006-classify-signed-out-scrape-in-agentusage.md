## Overview

agentusage currently lets a logged-out Claude profile mislabel as a slow
`panel_missing` timeout: `scrape()` sends `/usage`, no sentinel matches, the
full retry budget burns, and the login screen parses as a generic error. This
epic adds explicit OAuth sign-in detection so a logged-out profile classifies
fast and safely as a new `signed_out` success state — the producer half of the
`keeper usage` three-state surfacing (the keeper consumer half is its sibling epic).

## Quick commands

- `uv run python -m pytest` — the sign-in classification fixtures
- Manual: run the scrape against a logged-out config dir; confirm it returns
  `{status:"ok", signed_out:true}` without typing `/usage` into the OAuth paste field.

## Acceptance

- [ ] A logged-out profile classifies as `signed_out` pre-send (no timeout, no `/usage`
  typed into the OAuth paste field) and emits `{schema_version:1, status:"ok", signed_out:true}`.
- [ ] Detection uses a 2-of-3 sentinel quorum over the joined `screen.display`, sized from the spawn dims.
- [ ] A detector exception degrades to the existing `scrape_failed` arm (never crashes the util).
- [ ] Sign-in is disambiguated from the trust dialog and a merely-slow panel; `SCHEMA_VERSION` stays 1.

## Early proof point

The single task IS the proof — reliable pre-send detection of the sign-in screen against
a real logged-out render. If sentinels can't be pinned reliably, fall back to classifying
signed-out as a distinct `error_kind` via the existing parse-error path (label-only,
accepting today's slowness), and let the keeper sibling render that instead.

## References

- Panel-vetted design: the additive `signed_out:true` arm is the producer signal for keeper's
  new `account_state` axis. It is an ADDITIVE optional field on the existing `ok` arm
  (the `error_kind` precedent), so the contract `SCHEMA_VERSION` stays 1.
- Sibling consumer epic (keeper): "Surface usage account states" — threads `account_state`
  through the keeper fold/schema and renders the three no-bar states.
- Deploy order: deploy the keeper sibling (which parses this new arm) BEFORE deploying this
  agentusage change, or a pre-patch keeper reading `ok`+`signed_out:true` degrades that one
  account to `runner_failure` until keeper ships.
- Context: the `default` profile (`~/.claude`) is the case that exposed this — signed out,
  renders the OAuth screen.

## Best practices

- **Multi-sentinel quorum, not a single needle:** terminal wrapping/locale/mid-frame renders
  split any one string; require a 2-of-3 fingerprint over the joined `screen.display`, gated
  on alt-screen-active. Don't use "Welcome to Claude Code" as a sole needle. [practice-scout]
- **Classify pre-send:** detection must precede `send_slash_command` — `ctrl+u` does not protect
  the OAuth paste field; only classification-before-send does. [practice-scout]
- **Size the pyte Screen from the PTY spawn dimensions** or long lines wrap mid-token and split
  sentinels; join adjacent display lines before matching. [practice-scout]
- **Trust only the post-pyte `screen.display` for state decisions, never raw `child.before`** —
  adversarial ANSI cursor-jumps can spoof a state transition (Trail of Bits 2025). [practice-scout]
