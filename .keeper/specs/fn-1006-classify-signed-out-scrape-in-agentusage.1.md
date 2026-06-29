## Description

**Size:** M
**Files:** scrape.py, parse_claude_usage.py, agentusage/scrape_cli.py, tests (test_scrape_cli.py / test_parse_claude_usage.py)

### Approach

Detect the Claude Code OAuth sign-in screen and classify it as a new `signed_out`
success state, fixing both the mislabel (today it falls through to `panel_missing`)
and the slowness (today it burns the full `SLASH_RETRIES` budget waiting for a panel
that never renders). Detection must happen in `scrape()` **pre-send** — after the
initial `pump_until_idle`/render settle and BEFORE `send_slash_command` — because
`send_slash_command` does `sendcontrol("u") → send("/usage") → \r` into whatever field
has focus, and on the sign-in screen that field is the "Paste code here >" OAuth input
(typing `/usage` there submits a bogus auth code every cycle). Use a 2-of-3
multi-sentinel quorum over the joined `screen.display` text (join adjacent lines so a
wrap-split sentinel still matches; size the pyte Screen from the spawn dimensions),
gated on the alt-screen being active. Pin the concrete sentinels against a REAL
logged-out render (candidates: an OAuth `…/oauth/authorize…` URL, "Paste code here",
"sign in"/"Welcome to Claude Code" — do NOT use "Welcome to Claude Code" as a sole
needle; it can appear off the auth screen). Mirror the `NoActiveSubscription`
precedent: add a `SignedOut` exception and emit a new additive `ok`+`signed_out:true`
arm (exit 0) from `scrape_cli.run()`, sibling of the `no_subscription:true` arm. Keep
`SCHEMA_VERSION = 1` (additive optional field, the `error_kind` precedent). Detection
must live inside the existing `try` so an unexpected throw degrades to the existing
`scrape_failed` error arm rather than crashing the util. Disambiguate the sign-in
screen from the trust dialog (`_ensure_claude_dir_trusted`) and from a merely-slow
still-rendering panel.

### Investigation targets

**Required** (read before coding):
- scrape.py:323-330 — `send_slash_command` (the `ctrl+u`/`/usage`/`\r` paste-field hazard)
- scrape.py:~422-456 — the sentinel pump loop + the `terminal_short_circuit` / `appear_error` early-return pattern (~447-449) to mirror, moved BEFORE the send
- scrape.py:134 — `_ensure_claude_dir_trusted` (a logged-out profile may hit the trust dialog)
- scrape.py:~405 — spawn dimensions (size the pyte `Screen` from these)
- parse_claude_usage.py:35 — `NoActiveSubscription` (the exception precedent to mirror as `SignedOut`)
- agentusage/scrape_cli.py:124-151 — the 3 emit arms (`_ok_subscribed`/`_ok_no_subscription`/`_error`)
- agentusage/scrape_cli.py:202-230 — `run()` parse branch (catch `SignedOut` like `NoActiveSubscription`)

**Optional** (reference as needed):
- /Users/mike/code/agentusage/AGENTS.md (or CLAUDE.md) — repo conventions
- parse_claude_usage.py:232-280 — `parse()` no-bars fallback order (where a parser-level relabel would otherwise land)

### Risks

- Sentinel fragility — a single needle or "Welcome to Claude Code" alone false-positives;
  pin a 2-of-3 quorum against a real logged-out `pyte` render covering wrap variants.
- Paste-field poisoning if detection slips post-send — the pre-send placement is load-bearing.
- Trust-dialog false-positive — ensure trust handling runs first and isn't read as sign-in.
- Trust only the post-pyte `screen.display`, never raw bytes (ANSI spoofing).

### Test notes

Add pyte-render fixtures of the sign-in screen (incl. a wrap-split variant) asserting the
`ok`+`signed_out:true` arm; assert a non-login no-bars screen still resolves to
`no_subscription` / parse-error; assert a detector throw degrades to `scrape_failed`.
Keep the contract `schema_version` at 1.

## Acceptance

- [ ] A logged-out profile classifies as `signed_out` pre-send — no `/usage` typed into the
  OAuth paste field, no full-retry-budget timeout.
- [ ] `scrape_cli` emits `{schema_version:1, status:"ok", signed_out:true}` (exit 0); `SCHEMA_VERSION` stays 1.
- [ ] Detection uses a 2-of-3 sentinel quorum over the joined `screen.display`, sized from the spawn dims.
- [ ] A detector exception degrades to the existing `scrape_failed` arm (never crashes the util).
- [ ] Sign-in is disambiguated from the trust dialog and a merely-slow panel.
- [ ] Tests cover the signed_out arm, a wrap-split render, and the degrade-to-error path.

## Done summary
Detect the Claude Code OAuth sign-in screen pre-send via a 2-of-3 sentinel quorum over the joined, alt-screen-gated pyte display and raise SignedOut before /usage is typed into the paste field; scrape_cli emits an additive ok+signed_out:true arm (exit 0, SCHEMA_VERSION stays 1) with a detector throw degrading to scrape_failed.
## Evidence
