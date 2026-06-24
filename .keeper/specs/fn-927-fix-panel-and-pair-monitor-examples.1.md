## Description

**Size:** S
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/keeper/skills/pair/SKILL.md

### Approach

The Monitor tool schema accepts only `command`, `description`, `persistent`, `timeout_ms`
(`additionalProperties: false`) — there is no `until` property, so every example passing
`until=...` makes the model's first Monitor call fail with "Invalid tool parameters" before it
self-recovers. Remove the bogus param from all three example blocks:

- `plugins/plan/skills/panel/SKILL.md` (Step 2 fan-out, ~lines 68 and 75) — delete the
  `until="[keeper-pair] (completed|failed)",` line from BOTH Monitor blocks (the opus and codex
  legs). Leave the surrounding `command` / `description` / `timeout_ms` / `persistent` lines
  exactly as-is; they are already valid.
- `plugins/keeper/skills/pair/SKILL.md` (~line 49) — delete the `until=...` line. That block
  currently shows only `command` + `until=`, so round it out into a complete, copyable call by
  adding `description="pair codex"`, `timeout_ms=3600000`, and `persistent=false` in the file's
  existing double-quote kwarg style (`timeout_ms` must stay <= 3600000, the schema max).

Touch ONLY the `until=` lines plus the pair block's added fields. Do not edit the surrounding
prose that describes the `[keeper-pair]` stdout contract (`started` then a terminal line) — that
is the legitimate event stream the model reads by watching streamed stdout, not a Monitor
parameter. Forward-facing only: delete cleanly, leave no "removed until" / "no longer supports"
tombstone note.

### Investigation targets

**Required** (read before coding):
- plugins/plan/skills/panel/SKILL.md:64-79 — the Step 2 fan-out; both Monitor blocks carry `until=`.
- plugins/keeper/skills/pair/SKILL.md:46-51 — the lone Monitor block carrying `until=` and missing the required fields.

**Optional** (reference as needed):
- plugins/keeper/skills/await/SKILL.md:150-154 — a valid object-style Monitor example to mirror for the full param set.

## Acceptance

- [ ] `grep -rn "until=" plugins/` returns no hits in the panel or pair skill docs.
- [ ] Both panel Monitor blocks retain their valid `command` / `description` / `timeout_ms` / `persistent` fields, unchanged.
- [ ] The pair Monitor block is a complete, schema-valid example: `command`, `description`, `timeout_ms` (<= 3600000), `persistent`.
- [ ] No tombstone or back-reference to the removed param; the surrounding `[keeper-pair]` stdout-contract prose is unchanged.
- [ ] Committed via `keeper commit-work`.

## Done summary
Removed invalid until= param from panel (both fan-out blocks) and pair Monitor examples; rounded out the pair example to a complete schema-valid call.
## Evidence
