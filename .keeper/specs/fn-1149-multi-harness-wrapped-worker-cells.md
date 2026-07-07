## Overview

Extend the plan worker matrix beyond claude: a host-level `~/.config/keeper/matrix.yaml`
(ordered provider roster = cost pecking order, per-provider model lists with optional
native-id aliases, wrapper driver) grows the model axis with capability models served by
codex/pi. Wrapped cells render from the single composed worker template and delegate
implementation to the cost-preferred provider at run time; native claude cells and the
entire dispatch path stay byte-identical. The preset catalog auto-generates
`<provider>-<model>` presets from the roster. Decision record: docs/adr/0010.

## Quick commands

- keeper agent providers check
- keeper agent providers resolve gpt-5.5 high
- keeper prompt render-plugin-templates --project-root . && ls plugins/plan/workers/
- bun test && (cd plugins/plan && bun test) && (cd plugins/prompt && bun test)

## Acceptance

- [ ] A task assigned a wrapped capability model dispatches through the unchanged
      `--plugin-dir` path, its wrapper delegates to the first configured provider, and the
      landed commit carries the wrapper's Job-Id/Task trailers.
- [ ] Reordering the provider list changes which harness serves the next wrapped run with
      no rebuild or re-render.
- [ ] With no matrix.yaml present, rendering, selection, and dispatch behave byte-identically
      to today (claude opus/sonnet only).
- [ ] The selector can assign wrapped models: candidate cells appear in the brief and each
      roster model has a guidance block, enforced fail-loud.

## Early proof point

Task that proves the approach: ordinal 1 (matrix loader + providers verbs). If it fails:
revisit the matrix schema/derivations before any downstream task — the fallback is keeping
the axis in-repo-only, which changes only where the loader reads from.

## References

- docs/adr/0010-host-provider-matrix-and-wrapped-worker-cells.md — the settled decision and rejected alternatives
- CONTEXT.md — Provider / Pecking order / Wrapped cell / Wrapper driver glossary entries
- `fn-1146` (overlap) — both epics write CONTEXT.md and register verbs in the shared CLI
  descriptor tree (cli/descriptor.ts, cli/keeper.ts); fn-1146.5 claims ADR 0009, so this
  epic's ADR took 0010.
- Verified session facts: codex model_reasoning_effort and pi --thinking share band names
  minimal/low/medium/high/xhigh (pi adds off); keeper agent wait exists as the single-run
  wait verb; bare explicit-path git commits leave the session clean-check green while
  commit-work cannot stage foreign-session edits.

## Docs gaps

- **plugins/plan/README.md**: consolidate the worker-matrix narrative — wrapped cells, auto-generated presets, model-selector entry (task 8)
- **docs/plugin-composition-map.md**: revise cell rendering + launch-path claims for matrix-driven wrapped cells (task 8)
- **README.md**: update the keeper agent section — matrix.yaml, providers verbs, non-claude models as task cells (task 8)
- **docs/problem-codes.md**: add no_route rows as the codes land (tasks 1, 7)

## Best practices

- **Git is the changed-file truth:** derive the staging set from a pre-launch base sha plus
  git status; the foreign agent's files_changed is a both-directions reconciliation check only. [practice-scout]
- **Foreign JSON is attacker-influenced:** size-bound it, parse defensively, never
  shell-interpolate commit_message/summary into git commands. [practice-scout]
- **Cap retries before provider fallthrough** so the cost order does not flap. [LiteLLM prior art]
- **Pin foreign CLI versions** and treat their updates as supply-chain events. [practice-scout]
