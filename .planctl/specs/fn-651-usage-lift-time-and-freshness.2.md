## Description

**Size:** M
**Files:** ../agentuse/parse_claude_usage.py, ../agentuse/daemon.py, ../agentuse/README.md, ../agentuse/tests/test_parse_claude_usage.py, ../agentuse/tests/test_daemon_idle_stale_guard.py

### Approach

Compute the effective lift time in agentuse and emit it as a new
top-level `lift_at` field in the usage JSON envelope. agentuse already
parses per-window `{percent_used, resets_at}` (`parse_claude_usage.py`
`RESETS_RE` ln 58, windows ~ln 170-173) — this adds the derivation +
the envelope field.

1. **Derive lift_at (`parse_claude_usage.py`).** Add a pure helper that,
   given the parsed windows, returns the binding lift time = the
   soonest `resets_at` among windows whose `percent_used >= 100`, or
   `None` when no window is over its limit. (There is no explicit
   "exceeded" flag in the panel; `percent_used >= 100` is the signal.)
2. **Emit it (`daemon.py`).** Add `"lift_at"` to `ENVELOPE_KEYS`
   (~ln 382) and pass the value into `_build_envelope()` (~ln 398-428)
   on the success path (~ln 590-601). Carry it through the idle and
   stale paths the same way `usage` is preserved (so a paused/failed
   scrape doesn't drop a still-valid lift). ISO-8601 string, like
   `resets_at`; `null` when not over a limit / no usage.
3. **Docs.** Document `lift_at` in the envelope contract section of
   `../agentuse/README.md`.

Follow agentuse conventions: plain dicts (no pydantic), fail-open,
atomic writes via the existing `write_atomic` / `_build_envelope`
canonical-key enforcement. Keep the derivation a pure function for
direct unit testing.

### Investigation targets

**Required:**
- ../agentuse/parse_claude_usage.py ~ln 57-173 — `PERCENT_RE`, `RESETS_RE`, window parsing, the `{percent_used, resets_at}` shape.
- ../agentuse/daemon.py ~ln 382-428 — `ENVELOPE_KEYS` + `_build_envelope`; ~ln 484-621 — the success path; ~ln 498-545 — idle-skip preservation pattern.
- ../agentuse/README.md — the envelope contract section (keys + per-window shapes).

**Optional:**
- ../agentuse/tests/test_parse_claude_usage.py — fixture builders + deterministic `now=` injection.

### Risks

- **Which limit binds:** multiple windows can be at 100%; pick the soonest reset. A window at <100% is never binding even if it resets sooner.
- **Determinism in tests:** agentuse parser already takes an injectable `now`; reuse it so lift_at tests are deterministic.
- **Preservation:** ensure idle/stale envelope writes carry `lift_at` forward (mirror how `usage`/`subscription_active` are preserved), or a paused profile loses its lift mid-cooldown.

### Test notes

Parser: windows with session=100% (resets sooner) + week=100% (later) →
lift_at = session reset; session=100% only → session reset; nothing at
100% → None; no-subscription/no-usage → None. Daemon: success envelope
carries `lift_at`; idle/stale writes preserve the prior `lift_at`.

## Acceptance

- [ ] `parse_claude_usage.py` exposes a pure helper returning the soonest `resets_at` among `percent_used >= 100` windows, else `None`.
- [ ] `daemon.py` emits top-level `lift_at` (ISO | null) in the envelope via `ENVELOPE_KEYS` + `_build_envelope`, carried through success/idle/stale writes.
- [ ] `../agentuse/README.md` documents the new field.
- [ ] Tests cover binding-limit selection, no-limit → None, and idle/stale preservation; `uv run pytest` passes.

## Done summary

## Evidence
