## Description

**Size:** S
**Files:** src/derivers.ts, test/derivers.test.ts

### Approach

Add `extractPlanctlInvocation(hookEvent, toolName, data)` to `src/derivers.ts`
next to `extractSkillName`. Pure function: takes a hook event row's shape
(the same fields the hook already binds), returns
`{op, target, epic_id, task_id, subject_present} | null`. Gated by
`hookEvent === 'PreToolUse' && toolName === 'Bash'` — every other
combination returns `null` so the column stays NULL on unrelated rows and
the partial-index `WHERE planctl_op IS NOT NULL` predicate stays selective.

Parse `data.tool_input.command` with a module-scope anchored regex:

    ^(?:cd\s+\S+\s+&&\s+)?planctl\s+([a-zA-Z0-9_-]+)(?:\s+([^\s;&|]+))?

Op character class `[a-zA-Z0-9_-]+` avoids matching shell metachars as the
op; target group `[^\s;&|]+` avoids swallowing trailing `&&` or `;`.
Strip surrounding quotes from the captured target. Mirror jobctl's
`audit._derive_ids` 1:1 for the `target → (epic_id, task_id)` split by
reusing `parsePlanRef` — the spawn-name ref-shape and the planctl-target
ref-shape MUST agree byte-for-byte.

Compute `subject_present` from a hardcoded read-only verb allowlist:
`epics`, `tasks`, `cat`, `show`, `list`, `detect`, `gist`, `init`,
`claim`, `block`. Anything else with a parseable target shape is treated
as a mutation. Document the allowlist with a pointer to planctl's own
verb source so future planctl additions surface as a one-line edit here.

Never throws. Defensive against non-object `tool_input`, non-string
`command`, missing fields, malformed JSON-shaped values. Mirror
`extractSkillName`'s shape exactly (`src/derivers.ts:113-132`).

### Investigation targets

**Required** (read before coding):
- `src/derivers.ts:113-132` — `extractSkillName` is the closest analogue; gating + defensive-against-non-object pattern.
- `src/derivers.ts:235-275` — `parsePlanRef` + `PLAN_REF_RE` — reuse for the target id-split (Python `is_epic_id(target)` maps to `parsePlanRef(target)?.kind === 'epic'`).
- `src/derivers.ts:1-37` — module-level JSDoc on pure-deriver discipline + re-fold determinism contract.
- `src/derivers.ts:57-78` — `SLASH_COMMAND_RE` + `SPAWN_VERB_REF_RE` — module-scope regex literal pattern + shape commentary.
- `apps/planctl/planctl/audit.py:103-116` — the canonical `_derive_ids(target)` rule the new deriver ports.
- `apps/cli_common/cli_common/planctl_invocations.py:46-60` — the canonical invocation row shape returned by `parse_rows`.

**Optional**:
- `test/derivers.test.ts` (entire file) — table-driven test pattern, naming convention.
- `plugin/hooks/events-writer.ts:76-79` — `strField` precedent for object-shaped fields documented as strings.

### Risks

- Verb allowlist drift: planctl adds a new read-only verb and keeper doesn't update → false-positive creator/refiner links generated for read-only calls. Mitigation: document the allowlist with the source pointer; add a test that exercises every verb in the allowlist.
- Regex catastrophic backtracking on long commands: avoid nested quantifiers (current shape has none). Add a fixture with a 10KB command string.

### Test notes

Table-driven cases in `test/derivers.test.ts`. Cover at minimum: empty string, null input, malformed leading token, valid `planctl epic-create fn-575-foo`, valid `planctl task-create fn-575-foo "subject"`, `cd /tmp && planctl epics`, non-Bash hookEvent, non-Bash toolName, non-PreToolUse hookEvent, missing `tool_input`, non-string `command`, object-shaped `command`, absolute-path `/usr/local/bin/planctl …` (must return null), `bash -c 'planctl …'` (must return null), env-prefix `JOBCTL_FOO=1 planctl …` (must return null), every read-only verb (must produce `subject_present: false`), one mutation verb per category (must produce `subject_present: true`).

## Acceptance

- [ ] `extractPlanctlInvocation` exported from `src/derivers.ts` next to `extractSkillName`.
- [ ] Returns `null` for every non-matching hook event / tool name / data shape.
- [ ] Returns the parsed envelope for `cd /tmp && planctl epic-create fn-N-foo` and for bare `planctl epic-create fn-N-foo`.
- [ ] `subject_present: false` for every read-only verb in the allowlist; `true` for at least one mutation verb in each category.
- [ ] All 20+ table-driven test cases pass.
- [ ] Never throws under any input (verified by an "arbitrary garbage" fixture case).

## Done summary

## Evidence
