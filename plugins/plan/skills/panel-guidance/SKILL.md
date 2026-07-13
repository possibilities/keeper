---
name: panel-guidance
description: Compose or refresh the committed panel roster ladder from the live launch cube and model-selector guidance, then deliberately install the verified roster. Use when panel coverage, descriptions, membership, strength bands, or the installed panel.yaml needs a roster refresh.
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, AskUserQuestion, Bash(bun plugins/plan/scripts/panel-guidance-check.ts:*), Bash(keeper agent presets list:*), Bash(keeper agent providers check:*), Bash(cp plugins/plan/panel-selector.yaml:*)
---

# Panel guidance

Own the described panel roster at `plugins/plan/panel-selector.yaml` and its installed copy at
`~/.config/keeper/panel.yaml`. This is a slash-only, compose-not-research pass: derive the roster
from the live launch cube and the committed capability guidance already in
`plugins/plan/model-selector.yaml`. There is no research cache, references directory, or hash
parity work here.

The committed roster is the source of truth. `~/.config/keeper/panel.yaml` is a byte-identical
installed copy, including `default`; this skill is its sole resync writer. Do not hand-edit the
installed copy or make the install an implicit side effect of inspecting the roster.

## When to invoke

- A panel rung, member, strength band, description, or the default needs authoring or refresh.
- The live provider cube changes and panel membership must be reconciled to it.
- The structural panel gate fails, or the installed copy needs a deliberate resync.

## One compose-and-install pass

### 1. Read the governed inputs

Read the live cube and the guidance that defines what each model tier can honestly contribute:

```bash
keeper agent presets list --json
```

Read `plugins/plan/model-selector.yaml` alongside that output. The launch cube determines eligible
`<harness>::<model>::<effort>` members; the model guidance supplies the tier strengths, limits, and
when-to-pick distinctions. Never invent a capability claim in a panel description that contradicts
that guidance. Start from the existing `plugins/plan/panel-selector.yaml` when it is sound, so a
refresh is a deliberate policy edit rather than churn.

### 2. Compose the ladder

Write `plugins/plan/panel-selector.yaml` as exactly ten named panels, each an object with only
`strength`, `members`, and `description`, plus a top-level `default` naming one defined panel.
Keep the names meaningful but do not make downstream callers depend on them: callers select from
the live descriptions and strength bands.

The committed policy is closed and non-negotiable:

- Form a weak-to-max ladder of exactly 10 panels. Each has 2–3 unique members; every member uses
  only `high`, `xhigh`, or `max` effort.
- Use only the strength bands `weak`, `light`, `standard`, `strong`, and `max`, with at least one
  weak and one max rung. Weakness is model-tier weakness, never a shortcut created by dropping
  effort.
- Reserve the premium GPT flagship `gpt-5.6-sol` for the strong-and-max rungs, the flagship-grade
  panels convened for genuinely hard or high-stakes questions. Never place it in weak, light, or
  standard rungs or use it as a routine tie-breaker below that band.
- Define a default panel in the roster itself. It is a normal, panel-worthy baseline, not an
  instruction to fan out whenever one direct answer would suffice.

Keep descriptions nearly uniform in length and decision-dense. Each should say **use for X, not
Y**: name the task shape or stakes that justify the rung, then say what should stay below or move
above it. Explain a weak rung's low ceiling from its model tier and explicitly retain its effort;
for a weak question that needs no independent check, say to skip the panel entirely. Do not imply
that a larger member count alone makes a panel stronger.

Be candid about diversity. A single-family panel can be appropriate for a family-specific strength,
but must say that same-family agreement is weaker evidence because of shared blind spots. A
cross-family panel should say what independent disagreement or corroboration buys. Keep the
premium flagship in its reserved strong-and-max slots without falsely implying that every strong
rung carries it or has a flagship ceiling.

### 3. Gate the committed roster

Before any install, run the host-blind structural gate:

```bash
bun plugins/plan/scripts/panel-guidance-check.ts --check
```

Fix every reported structural error in the committed roster. The gate enforces the ten-panel shape,
member count and effort band, closed strength enum, weak/max coverage, description-length band,
and default reference. It deliberately does not prove that a member exists in the live provider
cube.

### 4. Deliberately install and prove the live cube

Once the structural gate is green, make the one explicit cutover write. Copy the committed roster
verbatim — do not format, merge, or regenerate it during installation:

```bash
cp plugins/plan/panel-selector.yaml ~/.config/keeper/panel.yaml
```

Then prove both load-bearing live properties: provider resolution against the cube, and the exposed
ladder that panel choosers will read:

```bash
keeper agent providers check
keeper agent presets list --json
```

If either verification fails, repair the committed roster, re-run the structural gate, and repeat
the explicit install. Never paper over the failure by editing `~/.config/keeper/panel.yaml`.

### 5. Commit the scoped pass

When this pass changed files, commit only `plugins/plan/panel-selector.yaml` and any tests pinned
to the roster-guidance surface, using the repository's standard commit seam. Keep unrelated dirty
files out of the pass. A no-change inspection has nothing to commit.
