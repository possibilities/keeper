## Description

**Size:** S
**Files:** (arthack, ~/code/arthack) apps/claudectl/claudectl/run_show_statusline.py, apps/claudectl/tests/test_show_statusline.py

### Approach

Cut the statusline's profile read from `AGENTWRAP_CLAUDE_PROFILE` to `KEEPER_AGENT_CLAUDE_PROFILE`, keeping the existing secondary `ARTHACK_CLAUDE_PROFILE` fallback. HARD cut (drop the agentwrap read entirely) so no agentwrap token lingers in arthack — for a single-user tool the brief window before keeper's producer rename (.2) lands is covered by the `ARTHACK_CLAUDE_PROFILE` fallback. Scrub the agentwrap mention in the surrounding doc comment too. Update the test (it currently monkeypatches `AGENTWRAP_CLAUDE_PROFILE`). Grep fresh — this runs after fn-1018 lands; line numbers are illustrative.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/claudectl/claudectl/run_show_statusline.py:108-109,130 — the env read + fallback chain + doc comment
- ~/code/arthack/apps/claudectl/tests/test_show_statusline.py — the monkeypatch test to update

### Risks

- Brief transient: between this landing and keeper's producer rename (.2), the statusline falls to `ARTHACK_CLAUDE_PROFILE` (or blank if unset). Acceptable for single-user; consumer-first ordering minimizes it.
- arthack has its own conventions/commit flow.

### Test notes

The updated test asserts `KEEPER_AGENT_CLAUDE_PROFILE` is read (+ `ARTHACK_` fallback). `git grep -i agentwrap` in arthack returns nothing after this lands.

## Acceptance

- [ ] run_show_statusline.py reads `KEEPER_AGENT_CLAUDE_PROFILE` then `ARTHACK_CLAUDE_PROFILE`; no `AGENTWRAP_` read or comment remains
- [ ] test updated + green
- [ ] zero agentwrap in arthack (outside `.keeper` history)

## Done summary
Renamed the arthack statusline profile read from AGENTWRAP_CLAUDE_PROFILE to KEEPER_AGENT_CLAUDE_PROFILE (hard cut, ARTHACK_CLAUDE_PROFILE fallback kept), updated the monkeypatch tests, and pruned the retired agentwrap vocabulary keyword. git grep -i agentwrap is now empty in arthack.
## Evidence
