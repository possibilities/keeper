## Description

**Size:** S
**Files:** plugins/keeper/skills/await/SKILL.md

### Approach

The `keeper:await` skill instructs agents to run `planctl show <target>
--format json` (the pre-check), but `planctl` is retired and not on PATH —
the live equivalent is `keeper plan show` (in-process alias, `cli/plan.ts` ->
`plugins/plan/src/cli.ts`). Replace the command invocations and reword the
prose that names the retired command. Verify `--format json` flag parity
against `plugins/plan/src/verbs/show.ts` before committing.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/await/SKILL.md:113-119 — the broken `planctl show` code block + error-path prose
- plugins/keeper/skills/await/SKILL.md:85,110-111,258,332,335 — other `planctl show` command references
- plugins/plan/src/verbs/show.ts — confirm `keeper plan show <target> --format json` parity (json/yaml/human via formatOutput)

**Optional**:
- other plan skills using `keeper plan show` (close/next) for phrasing parity

### Risks

Mechanical. Reword command-naming prose ("planctl board state / planctl id",
lines 5-6,29,56-58,76,81) to "keeper plan ..." where it names the tool; keep
generic concept usage readable. Do not rename the skill's own condition labels.

### Test notes

No automated test for skill prose. Smoke: `keeper plan show <existing-epic>
--format json` returns valid JSON.

## Acceptance

- [ ] no `planctl show` anywhere in await/SKILL.md (command block + example + prose)
- [ ] `keeper plan show ... --format json` flag parity verified against show.ts
- [ ] command-naming prose reworded to `keeper plan`; condition labels untouched

## Done summary
Replaced retired `planctl show` command invocations with `keeper plan show` in the await skill's planctl-target pre-check, and reworded tool-naming prose (description, condition table) to keeper plan. Verified --format json parity against show.ts.
## Evidence
