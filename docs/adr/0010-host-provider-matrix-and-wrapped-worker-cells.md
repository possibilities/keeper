# 10. Host-level provider matrix and wrapped worker cells

## Status

Accepted.

## Context

The plan worker matrix renders one `work` plugin per `{model × effort}` cell,
all claude-served: a task's `{model, tier}` selects the cell, the launcher
loads it via an additive `--plugin-dir`, and the cell's frontmatter bakes the
model and effort because Claude Code cannot override effort at spawn time.
keeper already drives three other harnesses (codex, pi, hermes) through
`keeper agent run`/`wait` with a per-harness descriptor registry and a named
preset catalog, but no path lets the plan selector assign a task to a model
those harnesses serve. The same model can be reachable through more than one
harness at different cost (a subscription-backed codex versus a per-token pi),
so any multi-harness design needs an operator-owned preference order that is
cheap to change, while the matrix axes must stay available at render time and
inside the compiled plan binary. Three shapes were live: a `harness` field on
tasks, a split between an in-repo capability axis and a host-level preference
file, and one unified host config from which everything else derives.

## Decision

The model axis subsumes the harness. A task keeps exactly `{model, tier}`; a
capability model like `gpt-5.5` is one more value on the model axis, and no
plan-schema field, fold, or projection learns about harnesses. One host-level
matrix config ties everything together: an ordered provider roster (each
provider is a harness name carrying the models it serves, with optional
capability→native-id aliases), the effort axis, the worker template list, and
the wrapper driver — the fixed claude model-and-effort that runs wrapped
cells. Provider list order is the pecking order, cost-ascending. Membership
under the claude provider makes a model native; every other model renders as a
wrapped cell whose worker delegates implementation to a provider resolved at
run time, so reordering preference is a one-line host edit with no rebuild.
A malformed matrix fails loud in CLIs and degrades to a visible sticky in the
daemon; an absent matrix falls back to the embedded in-repo defaults,
preserving today's claude-only behavior byte-identically.

Both cell kinds render from a single composed worker template — template-level
conditionals and shared partials, not a second template — so the worker
contract (phases, return format, escalation taxonomy) exists once and cannot
drift between native and wrapped. The wrapped close-out derives its staging
set from git against a pre-launch base commit (the foreign agent's declared
file list is a reconciliation signal, never the source), lands one commit
carrying the wrapper's own job trailers, and normalizes any commit the foreign
agent made despite its contract by soft-resetting to the base first. The
preset catalog auto-generates one `<provider>-<model>` preset per roster pair
in memory at load, colliding fail-loud with hand-authored presets.

Rejected: a `harness` task field (migration plus fold churn to encode a fact
the model value already implies); a separate preference file beside an in-repo
axis (two files that must agree, with the pecking order unable to see the
axis); a second worker template or separate wrapped-cell tree (contract drift
between near-identical templates, and a new plugin base that perturbs the
shadow-collision and dispatch-composition seams); dispatch-time harness
resolution (bakes the provider choice into the reconciler, so reordering would
touch autopilot instead of being a pure config edit).

## Consequences

- Existing tasks, the selector verdict schema, `assign-cells`, the dispatch
  cell composition, and every fold stay unchanged; re-fold determinism is
  untouched because harness resolution lives producer-side and at run time.
- The renderer, the plan verbs, and the agent launcher each read the matrix
  through their own island's loader with the embedded defaults as fallback;
  test suites pin the embedded defaults so they stay host-independent.
- A wrapped capability with no configured provider surfaces as a typed
  dispatch reject naming the matrix file, not a silent skip.
- The wrapper pays a second model invocation per wrapped task (driver plus
  foreign run); the pecking order encodes cost only, and treats providers
  serving the same model as behaviorally interchangeable — a quality gap
  between providers is invisible to it.
- Effort vocabulary is translated per harness through descriptor data, so new
  harnesses add a map entry rather than a name-switch.
