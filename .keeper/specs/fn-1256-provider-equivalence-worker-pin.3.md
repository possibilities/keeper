## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/rpc-handlers.ts, cli/autopilot.ts, src/autopilot-projection.ts, src/collections.ts, plugins/keeper/skills/autopilot/SKILL.md

### Approach

Add `autopilot_state.worker_provider` (`TEXT`, nullable, no default, no backfill) through
the generic config path — the codex_adoption recipe with one genuine novelty: this is the
first non-numeric config column, so the reducer gains a string-enum parse branch (accept
exactly `claude`/`codex`/null; anything else folds to a safe no-op, never a throw) and the
RPC validator gains a string-enum clause (reject bad values loud at the socket). CLI:
`keeper autopilot config worker_provider <claude|codex|none>` (`none` clears to NULL),
wired through buildSetConfigFrame, surfaced in `keeper autopilot show` with the scope note
("work cells only") and, when set to claude, a line naming the many-to-one tier collapse.
Update the autopilot skill's config table, show envelope example, and take-over
capture/restore set. The migration step's version is assigned at merge time (docs/adr/0020)
— never hardcode the next number; re-pin SCHEMA_FINGERPRINT per the schema-change rule.
This task deliberately does NOT touch dispatch behavior — the producer read and translation
land in task .4.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:5782 (CREATE_AUTOPILOT_STATE) and :3853 (codex_adoption addColumnIfMissing step) — the column + migration recipe
- src/reducer.ts:5321-5445 — AUTOPILOT_CONFIG_COLUMNS, AutopilotConfigSetPayload, existing coercion clauses (all numeric — yours is the first TEXT enum)
- src/rpc-handlers.ts:373-471 — validateSetAutopilotConfigParams known set + per-field validators
- cli/autopilot.ts:715 (buildSetConfigFrame), :1332-1433 (config subcommand branches incl. null sentinels `unlimited`/`default`), :456-500 (show struct)

**Optional** (reference as needed):
- src/autopilot-projection.ts:81-103 — projectWorktreeMultiRepo helper pattern
- src/collections.ts:729-759 — collections descriptor rows
- plugins/keeper/skills/autopilot/SKILL.md — config table, show envelope, capture/restore list
- cli/descriptor.ts + help golden tests — help-text ripple the CLI branch causes

### Risks

- Schema ladder is a singleton resource; no open sibling epics exist today, but keep the step additive-idempotent and merge-renumberable
- Help/golden consistency tests pin CLI strings — expect to update them, not fight them

### Test notes

Pure tier: freshMemDb + migrate, patch round-trip through the fold (set, clear via null,
reject-garbage folds safely), RPC validator accept/reject table, CLI frame building. Show
envelope snapshot updates.

## Acceptance

- [ ] `worker_provider` round-trips set/clear through set_autopilot_config and survives daemon restart (durable column, migration green on an existing DB)
- [ ] An invalid value is rejected at the RPC with a message naming the allowed set; a malformed patch value never throws inside the fold
- [ ] `keeper autopilot config worker_provider <claude|codex|none>` works and `keeper autopilot show` renders the value with its work-cells-only scope note
- [ ] Autopilot skill docs cover the knob (table row, show example, capture/restore set)
- [ ] Fast suite green

## Done summary
Adds the durable autopilot_state.worker_provider TEXT-enum dispatch pin (NULL|claude|codex) through the generic set_autopilot_config path: reducer's first non-numeric config parse branch, RPC string-enum validator, CLI config subcommand + show envelope (scope note + claude tier-collapse note), and autopilot skill docs. Dispatch translation deferred to task .4.
## Evidence
