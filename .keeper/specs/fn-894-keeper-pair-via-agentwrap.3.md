## Description

**Size:** S
**Files:** plugins/keeper/skills/pair/SKILL.md (+ optional references/)

### Approach

Author `plugins/keeper/skills/pair/SKILL.md` as a sibling of dispatch/await/bus/autopilot —
auto-discovered (no manifest edit), model-invocable (omit `disable-model-invocation`), with
a trigger-rich `description` (pair with another model, second opinion, ask claude/codex,
cross-check). Capture pairctl's pairing know-how as ADVICE, not config: the Monitor-in-main
pattern (`Monitor(command='keeper pair send …')`, wait in silence, read `--output` on
`completed`), choosing `--cli`/`--model`/`--effort`/`--role`/`--read-only`, and the reveal
path for the full transcript. State the read-only limitation honestly (detection-not-
prevention). Keep it lean and prose-shaped like `bus/SKILL.md`.

### Investigation targets

**Required**:
- plugins/keeper/skills/dispatch/SKILL.md + plugins/keeper/skills/bus/SKILL.md — frontmatter shape + advice style to mirror.

### Risks

- Keep advice, not a config dump; forward-facing prose only.

### Test notes

Render check via the plugin's skill tooling if present; otherwise manual frontmatter validation.

## Acceptance

- [ ] `plugins/keeper/skills/pair/SKILL.md` exists, is model-invocable with a trigger-rich description.
- [ ] Documents driving `keeper pair` incl. the Monitor-in-main pattern, read-only, and reading `--output`.

## Done summary
Authored plugins/keeper/skills/pair/SKILL.md — an auto-discovered, model-invocable /keeper:pair skill documenting the Monitor-in-main pairing pattern, --cli/--role/--read-only selection, reading the --output YAML, and the detection-not-prevention read-only caveat.
## Evidence
