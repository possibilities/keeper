## Overview

keeper's agent-interaction skills (keeper:pair, keeper:handoff, plan:panel and its runner agent) re-narrate five shared operational contracts near-verbatim, and the shared vocabulary for the two intent families (elicit-an-answer vs delegate-work) is undefined. This epic single-sources the contracts into one keeper-local reference doc the skills cite, adds the missing CONTEXT.md glossary terms, and records the convergence non-goals in an ADR — zero behavior change.

## Quick commands

- `rg -l "agent-surface-contracts" docs plugins/keeper/skills plugins/plan | sort` — the doc exists and every converted prose file cites it
- `cd plugins/plan && bun test test/consistency-skills.test.ts` — the literal-token contract gate stays green
- `cd plugins/prompt && bun test` — vendored-corpus drift gate untouched

## Acceptance

- [ ] One keeper-local reference doc canonically states the five shared contracts (chunked-wait timing, PANEL_RUN_CONTROL_V1 header, 9-key answer envelope, final-message-is-the-deliverable rule, panel-start idempotency)
- [ ] pair/handoff/panel skill prose and the panel-runner agent cite that doc instead of re-narrating full contract prose, while retaining their literal contract tokens and per-surface task framing
- [ ] CONTEXT.md defines Partner, Handoff, the two intent families, and Launch handle (with per-surface idempotency scope)
- [ ] A docs/adr/ record codifies the convergence non-goals and the contracts-home decision
- [ ] No behavior change: no code path, test contract, or vendored corpus file is modified beyond prose cites

## Early proof point

Task that proves the approach: ordinal 1 (the reference doc + skill conversion). If the consistency test cannot stay green with condensed summaries, fall back to keeping fuller inline prose plus the canonical cite — the doc still wins on wording disputes.

## References

- Warm-handoff design conclusion: two intent families over one launch transport (`keeperAgentLaunch`); pair's detached mode IS the `agent panel start/wait` engine; handoff differs by RESULT CONTRACT (parks at confirm, no deliverable), not by wait-vs-forget
- `fn-1282-retire-hermes-codex-harnesses` (dependency) — its in-flight branch rewrites pair/panel skill prose (~25/~4/~20 lines) this epic converts; single-source after it lands so the doc snapshots post-retirement wording
- Snippet corpus is vendored read-only from arthack (drift-gated by vendor.lock, domains engineering/source-dirs); that is why the contracts live in a keeper-local doc, NOT vendored BAKE snippets — and why skills cite it with a plain canonical-source line, never a `POINTER:` marker (those must resolve in the corpus)
- Duplicated passages inventory: wait contract (pair SKILL + panel-runner), PANEL_RUN_CONTROL_V1 (panel SKILL + panel-runner), envelope field list (pair SKILL + panel references/panel.md), deliverable/sole-injection rule (pair SKILL + references/panel.md), panel-start idempotency (pair SKILL + panel SKILL)

## Docs gaps

- **docs/skill-authoring.md**: add the "shared contract → single-sourced reference doc, not copied prose" authoring pattern
- **docs/plugin-composition-map.md**: the contracts doc joins the composition map
- **plugins/plan/README.md / plugins/plan/CLAUDE.md**: point panel/envelope mechanics at the single source instead of restating

## Best practices

- **Single-source mechanical constants only:** keep per-surface task framing (objective, output shape, tool guidance) local to each skill — flattening it into vague shared prose causes mis-scoped delegation [Anthropic multi-agent]
- **One versioned envelope contract:** the shared field list is the drift anchor for pair, panel, and any future capture path
