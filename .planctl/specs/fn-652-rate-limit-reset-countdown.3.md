## Description

**Size:** S
**Files:** src/collections.ts, cli/usage.ts, README.md, test/collections.test.ts, test/usage.test.ts

### Approach

Surface the projected column on the wire and render the lift countdown.

1. **Descriptor (src/collections.ts).** Add `"last_rate_limit_resets_at"`
   to the `USAGE_DESCRIPTOR` columns array (~ln 400-419) and to
   `PROFILES_DESCRIPTOR` (~ln 450-457). That alone makes it ride the
   subscribe wire; the existing `version: "last_event_id"` drives the diff.
2. **Render (cli/usage.ts).** Change the rate-limit line to show the
   **lift time** instead of the fired-time:
   - When `last_rate_limit_resets_at` is non-null AND still future →
     render the user's target phrasing, "rate-limited for <rel>", where
     `<rel>` comes from `relTimeFromUnixSec(last_rate_limit_resets_at, nowMs)`
     (already renders future times bare, e.g. "1h 2m").
   - When there is no value (NULL) → render `n/a`. That is the only
     no-value behavior. Do NOT render `last_rate_limit_at` (the
     fired-time) anywhere on this line.
   - Keep the existing codex suppression (`isCodex`) — codex has no
     rate-limit concept.
3. **Change-gate (cli/usage.ts `usageRowsHashKey`, ~ln 671-697).**
   CRITICAL: add `r.last_rate_limit_resets_at` to the hashed projection
   subset, or a reset-only change (same `last_rate_limit_at`, new
   `resets_at`) will land on the wire but never repaint the frame.
4. **Docs.** Update the cli/usage.ts file-header JSDoc + the `HELP`
   string (the annotation now renders a lift countdown), and the README
   `usage` collection description block.

The fired-time (`last_rate_limit_at`) is no longer the rendered
rate-limit annotation — it remains on the row for other consumers but
is not shown on this line.

### Investigation targets

**Required** (VERIFY line numbers against the live `cli/usage.ts` — it
was recently moved from `scripts/usage.ts` and fn-646 is mid-edit on it):
- cli/usage.ts — `renderRowLines` / the `RowCells` assembly, the `rlRel` computation, `renderRateLimit`, the label-pool width logic, and `relTimeFromUnixSec` (future-time rendering).
- cli/usage.ts `usageRowsHashKey` (~ln 671-697) — the change-gate.
- src/collections.ts — `USAGE_DESCRIPTOR` (~ln 400-419) and `PROFILES_DESCRIPTOR` (~ln 450-457).

**Optional:**
- test/usage.test.ts ~ln 420-524 — existing "rate-limited <rel>" render tests (omit-when-NULL, omit-for-codex, alignment) — the template for the new countdown + `n/a` tests.

### Risks

- **Change-gate omission** is a silent-staleness bug — easy to miss; the gate's docstring lists what's hashed.
- **Label/column width** — the `n/a` string and the "for <rel>" form must align with the other quota lines' width math.
- **fn-646 is actively editing `cli/usage.ts`** (its OpenTUI cutover) — coordinate / land after it to avoid a merge conflict; if it relocates the file, follow.

### Test notes

Render: shows "rate-limited for Nh Mm" when `resets_at` is future; shows
`n/a` when `resets_at` is NULL — and asserts it does NOT render the
fired-time in that case; omits the line for codex; the change-gate hash
includes `last_rate_limit_resets_at`. Collections: the new column appears
in the usage + profiles wire shape.

## Acceptance

- [ ] `last_rate_limit_resets_at` rides the `usage` and `profiles` collection wire (added to both descriptors).
- [ ] The usage TUI renders "rate-limited for <rel>" (countdown) when the reset is known and future, and `n/a` whenever there is no value — never the fired-time.
- [ ] `usageRowsHashKey` includes the new column so a reset-only change repaints the frame.
- [ ] codex stacks still omit the rate-limit line.
- [ ] cli/usage.ts header/HELP and README `usage` block updated; render + collections tests pass.

## Done summary

## Evidence
