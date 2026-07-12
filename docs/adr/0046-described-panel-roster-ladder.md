# 0046 — Described panel roster ladder, generated and gated

## Status

Accepted. Relates to ADR 0033 (launch triples over a named preset catalog) — panels keep launch
triples as members; this record changes how panels are described, authored, and chosen, not what a
member is.

## Context

Panels were hand-written in `~/.config/keeper/panel.yaml` as bare lists of launch triples, and the
choosing guidance told agents to infer a panel's strength from its member count and harness
diversity. That heuristic carries no task-shape signal (when is a rung right, when is it overkill),
the hand-written roster covered only two rungs, and nothing bound the roster to the fleet's actual
model-capability guidance. Choosing agents also exhibit a documented default-to-strongest /
length-bias drift when picking among described options, which unguided descriptions amplify.

## Decision

- **Schema**: each panel value in `panel.yaml` is an object `{strength, members, description}` —
  a clean cutover with no legacy list acceptance. The validating loader checks structure only
  (object shape, non-empty members of panel-eligible triples, non-empty strength/description) and
  rejects a legacy list-form panel with a remediation error naming `/plan:panel-guidance`. The
  lenient host-triples harvester keeps reading members from both shapes so the doctor lint and
  `presets list` never go dark on a stale file.
- **Policy lives in a gate, not the loader**: a committed roster at
  `plugins/plan/panel-selector.yaml` is enforced by the purely-structural
  `plugins/plan/scripts/panel-guidance-check.ts` (10 panels, 2–3 members each, efforts drawn from
  high/xhigh/max only, closed band enum weak|light|standard|strong|max with at least one weak and
  one max rung, no duplicate members, bounded near-uniform description lengths, `default` naming a
  defined panel) — mirroring the loadMatrix-parses / providers-check-enforces split. The gate is
  host-blind; cube membership is verified at install time via `keeper agent providers check`, and a
  committed off-cube triple is deliberately not a CI failure.
- **Authoring**: the slash-only `/plan:panel-guidance` skill composes (never researches) the ladder
  from the live launch cube and `model-selector.yaml`'s capability blocks, writes the committed
  roster, and installs it verbatim to `~/.config/keeper/panel.yaml` — the skill is the sole resync
  writer of the installed copy. No research cache, no hash parity: unlike `/model-guidance`, its
  inputs are already-governed artifacts.
- **Choosing**: agents read the roster live (`keeper agent presets list --json`, which carries each
  panel's strength and description) and pick the weakest panel whose description covers the task,
  escalating only on observable triggers (ambiguity, blast radius, irreversibility, security). The
  `engineering/panel-strength` snippet carries methodology only — never panel names or
  descriptions — so roster edits need no cross-repo re-bake.
- **Weakness comes from model tier, not effort**: every rung runs high/xhigh/max so light panels
  still think hard with lighter models; strength bands are authored, not derived from member count.

## Consequences

Hand-written `small`/`medium` panels retire; an explicit `--panel small` exits 2 with the panel
list (intended). An installed list-form `panel.yaml` fails every panel launch with the remediation
error until the skill regenerates it — the one migration this change carries; there is no DB or
daemon impact. Duplicate members stay legal at the loader/launch layer (ordinal disambiguation) but
are rejected in the committed roster, where a duplicated member is a degenerate panel.
